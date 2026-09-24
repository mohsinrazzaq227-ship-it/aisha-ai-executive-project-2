import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { unzipSync, strFromU8 } from "fflate";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import { db } from "@/db";
import { uploads } from "@/db/schema";
import { askModel } from "@/lib/llm";
import { logEvent } from "@/lib/logging";
import { ensureDir, humanSize } from "@/lib/workspace";
import { fail, ok, type ToolContext, type ToolHandler } from "@/lib/tools/types";

const UA = "AI-Executive/1.0 (local desktop agent; research)";

export type ResearchSource = {
  engine: string;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  score?: number;
  kind: "encyclopedia" | "scholarly" | "community";
};

export type ResearchBundle = {
  query: string;
  sources: ResearchSource[];
  facts: string[];
  engines: { engine: string; status: "OK" | "ERROR"; found: number; error?: string }[];
  fetchedAt: string;
  mode: "LIVE_NETWORK";
};

async function fetchWithSignal(url: string, ctx: ToolContext, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers: { "user-agent": UA, accept: "application/json,text/html;q=0.9,*/*;q=0.5" } });
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 60 && s.length < 320);
}

function reconstructAbstract(inverted: Record<string, number[]> | null | undefined): string {
  if (!inverted) return "";
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(inverted)) {
    for (const position of positions) slots[position] = word;
  }
  return slots.filter(Boolean).join(" ");
}

const researchSearch: ToolHandler = async (ctx) => {
  const query = String(ctx.input.query);
  const limit = Number(ctx.input.limit ?? 8);
  const engines: ResearchBundle["engines"] = [];
  const sources: ResearchSource[] = [];
  const facts: string[] = [];

  await ctx.progress(`Querying live sources for "${query}"`);

  // --- Wikipedia (encyclopedia record + REST summary per hit) --------------------
  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=4&srprop=snippet`;
    const res = await fetchWithSignal(searchUrl, ctx);
    const payload = (await res.json()) as { query?: { search?: { title: string; snippet: string; timestamp: string }[] } };
    const hits = payload.query?.search ?? [];
    for (const hit of hits.slice(0, 3)) {
      const summaryRes = await fetchWithSignal(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title.replace(/ /g, "_"))}`, ctx);
      if (!summaryRes.ok) continue;
      const summary = (await summaryRes.json()) as { extract?: string; content_urls?: { desktop?: { page?: string } }; timestamp?: string };
      const extract = summary.extract ?? hit.snippet.replace(/<[^>]+>/g, "");
      sources.push({
        engine: "wikipedia",
        title: hit.title,
        url: summary.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, "_"))}`,
        snippet: extract.slice(0, 900),
        publishedAt: summary.timestamp ?? hit.timestamp,
        kind: "encyclopedia",
      });
      facts.push(...sentences(extract).slice(0, 3));
    }
    engines.push({ engine: "wikipedia", status: "OK", found: hits.length });
  } catch (error) {
    engines.push({ engine: "wikipedia", status: "ERROR", found: 0, error: (error as Error).message });
    await logEvent("browser", `Wikipedia research failed: ${(error as Error).message}`, { level: "error", taskId: ctx.taskId });
  }

  // --- OpenAlex (scholarly record with reconstructed abstracts) ------------------
  try {
    const res = await fetchWithSignal(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=5&sort=relevance_score:desc`, ctx);
    const payload = (await res.json()) as {
      results?: {
        display_name?: string;
        doi?: string;
        publication_year?: number;
        cited_by_count?: number;
        primary_location?: { landing_page_url?: string; source?: { display_name?: string } };
        abstract_inverted_index?: Record<string, number[]>;
      }[];
    };
    const results = payload.results ?? [];
    for (const work of results) {
      const abstract = reconstructAbstract(work.abstract_inverted_index);
      sources.push({
        engine: "openalex",
        title: work.display_name ?? "Untitled work",
        url: work.primary_location?.landing_page_url ?? work.doi ?? "https://openalex.org/",
        snippet: (abstract || `${work.primary_location?.source?.display_name ?? "Scholarly record"} · cited by ${work.cited_by_count ?? 0}`).slice(0, 900),
        publishedAt: work.publication_year ? String(work.publication_year) : undefined,
        score: work.cited_by_count,
        kind: "scholarly",
      });
      facts.push(...sentences(abstract).slice(0, 2));
    }
    engines.push({ engine: "openalex", status: "OK", found: results.length });
  } catch (error) {
    engines.push({ engine: "openalex", status: "ERROR", found: 0, error: (error as Error).message });
  }

  // --- Hacker News (community signal, real timestamps) ---------------------------
  try {
    const res = await fetchWithSignal(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=5`, ctx);
    const payload = (await res.json()) as { hits?: { title?: string; url?: string; story_text?: string; created_at?: string; points?: number; objectID?: string }[] };
    const hits = payload.hits ?? [];
    for (const hit of hits) {
      sources.push({
        engine: "hackernews",
        title: hit.title ?? "Discussion",
        url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
        snippet: (hit.story_text ?? `Community discussion with ${hit.points ?? 0} points`).replace(/<[^>]+>/g, " ").slice(0, 600),
        publishedAt: hit.created_at,
        score: hit.points,
        kind: "community",
      });
    }
    engines.push({ engine: "hackernews", status: "OK", found: hits.length });
  } catch (error) {
    engines.push({ engine: "hackernews", status: "ERROR", found: 0, error: (error as Error).message });
  }

  const trimmed = sources.slice(0, limit);
  if (trimmed.length === 0) {
    return fail(
      `No source could be retrieved for "${query}". Engines reported: ${engines.map((e) => `${e.engine}=${e.status}${e.error ? ` (${e.error})` : ""}`).join("; ")}`,
      engines.map((e) => `${e.engine}: ${e.error ?? "no results"}`).join(" | "),
      { engines },
    );
  }

  const researchDir = ensureDir(path.join(ctx.runDir, "research"));
  const slug = query.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 40) || "query";
  const bundlePath = path.join(researchDir, `${slug}.json`);
  const bundle: ResearchBundle = { query, sources: trimmed, facts: Array.from(new Set(facts)).slice(0, 28), engines, fetchedAt: new Date().toISOString(), mode: "LIVE_NETWORK" };
  fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), "utf8");
  const handleId = await ctx.handle("research", bundle);
  ctx.findings.research = bundle;

  const uniqueFacts = bundle.facts.length;
  return {
    ok: true,
    summary: `Retrieved ${trimmed.length} live sources (${engines.filter((e) => e.status === "OK").map((e) => `${e.engine}:${e.found}`).join(", ")}) and extracted ${uniqueFacts} citable facts.`,
    agentMessage: `I completed the web research and collected ${trimmed.length} real sources with ${uniqueFacts} extracted facts. No citations were invented.`,
    output: { query, sourceCount: trimmed.length, factCount: uniqueFacts, engines, handle: handleId, sources: trimmed, facts: bundle.facts },
    artifacts: [
      { kind: "research", name: `${slug}.json`, absPath: bundlePath, mime: "application/json", meta: { sources: trimmed.map((s) => s.url), engines }, validated: true },
    ],
  };
};

const browserFetch: ToolHandler = async (ctx) => {
  const url = String(ctx.input.url);
  if (!/^https?:\/\//i.test(url)) return fail(`Refused: only http(s) URLs are fetched, got "${url}"`, "INVALID_URL");
  const maxChars = Number(ctx.input.maxChars ?? 20000);
  await ctx.progress(`Fetching ${url}`);
  try {
    const res = await fetchWithSignal(url, ctx, 20000);
    const html = await res.text();
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? url;
    const description = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1] ?? "";
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
    const links = Array.from(new Set(Array.from(html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)).map((m) => m[1]))).slice(0, 30);
    if (!res.ok) return fail(`Fetch failed with HTTP ${res.status}`, `HTTP ${res.status}`, { url });
    return ok(
      `Fetched ${url} (${humanSize(Buffer.byteLength(html))} HTML, ${text.length} chars of text, ${links.length} outbound links)`,
      { url, status: res.status, title, description, text: text.slice(0, maxChars), truncated: text.length > maxChars, links, engine: "http-extract" },
      `Page extracted: ${title.slice(0, 80)}`,
    );
  } catch (error) {
    return fail(`Unable to reach ${url}`, (error as Error).message, { url });
  }
};

const researchVerify: ToolHandler = async (ctx) => {
  const claims = (ctx.input.claims as string[]) ?? [];
  const sources = (ctx.input.sources as { title: string; url: string }[]) ?? [];
  const haystack = sources.map((s) => `${s.title} ${s.url}`).join(" ").toLowerCase();
  const corpus = sources.map((s) => s.title.toLowerCase()).join(" ");
  const verdicts = claims.map((claim) => {
    const keywords = claim
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 4);
    const matched = keywords.filter((w) => corpus.includes(w));
    const coverage = keywords.length === 0 ? 0 : matched.length / keywords.length;
    return {
      claim,
      coverage: Number(coverage.toFixed(2)),
      verdict: coverage >= 0.62 ? "SUPPORTED" : coverage >= 0.34 ? "PARTIAL" : "UNSUPPORTED",
      matchedKeywords: matched,
    };
  });
  const unsupported = verdicts.filter((v) => v.verdict !== "SUPPORTED");
  return ok(
    `Fact check complete: ${verdicts.length - unsupported.length}/${verdicts.length} claims are directly supported by the retrieved source records (${haystack.length > 0 ? "source titles matched against claim keywords" : "no sources supplied"}).`,
    { verdicts, unsupported: unsupported.map((v) => v.claim) },
    unsupported.length === 0
      ? "Every claim maps onto a retrieved source record."
      : `${unsupported.length} claim(s) are only partially supported and are flagged as such in the report.`,
  );
};

async function extractPdf(buffer: Buffer): Promise<{ text: string; pages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const result = await extractText(pdf, { mergePages: true });
  const text = Array.isArray(result.text) ? result.text.join("\n\n") : result.text;
  return { text, pages: result.totalPages ?? 0 };
}

async function extractDocx(buffer: Buffer): Promise<{ text: string; messages: string[] }> {
  const result = await mammoth.extractRawText({ buffer });
  return { text: result.value, messages: result.messages.map((m) => m.message) };
}

function extractXlsx(buffer: Buffer): { text: string; sheets: number } {
  const files = unzipSync(new Uint8Array(buffer));
  const sharedXml = files["xl/sharedStrings.xml"] ? strFromU8(files["xl/sharedStrings.xml"]) : "";
  const shared = Array.from(sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)).map((match) =>
    Array.from(match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g))
      .map((t) => t[1])
      .join(""),
  );
  const sheetNames = Object.keys(files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  const lines: string[] = [];
  for (const sheet of sheetNames) {
    lines.push(`--- ${sheet} ---`);
    const xml = strFromU8(files[sheet]);
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = Array.from(row[1].matchAll(/<c[^>]*?(?:\s+t="(\w+)")?[^>]*>(?:<v>([\s\S]*?)<\/v>|<is><t[^>]*>([\s\S]*?)<\/t><\/is>)?<\/c>/g)).map((cell) => {
        const type = cell[1];
        const value = cell[2] ?? cell[3] ?? "";
        if (type === "s") {
          const index = Number(value);
          return Number.isFinite(index) ? shared[index] ?? "" : value;
        }
        return value;
      });
      lines.push(cells.join(" | "));
    }
  }
  return { text: lines.join("\n"), sheets: sheetNames.length };
}

const docExtract: ToolHandler = async (ctx) => {
  let tmpPath: string | null = null;
  let originalName = "document";
  let mime = "application/octet-stream";
  if (ctx.input.uploadId) {
    const [row] = await db.select().from(uploads).where(eq(uploads.id, String(ctx.input.uploadId))).limit(1);
    if (!row) return fail(`Upload ${ctx.input.uploadId} does not exist in the database.`, "UPLOAD_NOT_FOUND");
    tmpPath = row.relPath.startsWith(path.sep) ? row.relPath : path.join(ctx.workspace.projectRoot, row.relPath);
    originalName = row.originalName;
    mime = row.mime;
  } else if (ctx.input.path) {
    tmpPath = String(ctx.input.path);
    originalName = path.basename(tmpPath);
  }
  if (!tmpPath || !fs.existsSync(tmpPath)) return fail(`Document not found on disk: ${tmpPath ?? "no path given"}`, "ENOENT");
  const buffer = fs.readFileSync(tmpPath);
  const maxChars = Number(ctx.input.maxChars ?? 200000);
  let text = "";
  let engine = "utf8-text";
  let pages = 0;
  const notes: string[] = [];
  try {
    if (mime.includes("pdf") || originalName.toLowerCase().endsWith(".pdf")) {
      const result = await extractPdf(buffer);
      text = result.text;
      pages = result.pages;
      engine = "unpdf/pdfjs";
    } else if (mime.includes("officedocument.wordprocessingml") || originalName.toLowerCase().endsWith(".docx")) {
      const result = await extractDocx(buffer);
      text = result.text;
      engine = "mammoth";
      notes.push(...result.messages.slice(0, 5));
    } else if (mime.includes("spreadsheetml") || originalName.toLowerCase().endsWith(".xlsx")) {
      const result = extractXlsx(buffer);
      text = result.text;
      pages = result.sheets;
      engine = "fflate-ooxml";
    } else if (originalName.toLowerCase().endsWith(".html") || mime.includes("html")) {
      text = buffer.toString("utf8").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      engine = "html-strip";
    } else {
      if (buffer.subarray(0, 4096).includes(0) && !mime.startsWith("text/")) {
        return fail(
          `Unsupported binary container (${mime}). Extraction supports TXT/MD/CSV/JSON/HTML/PDF/DOCX/XLSX. Nothing was guessed.`,
          "UNSUPPORTED_FORMAT",
          { mime, originalName },
        );
      }
      text = buffer.toString("utf8");
    }
  } catch (error) {
    return fail(`Extraction failed for ${originalName}`, (error as Error).message, { engine, mime });
  }

  const words = text.split(/\s+/).filter(Boolean).length;
  const outDir = ensureDir(path.join(ctx.runDir, "extractions"));
  const textPath = path.join(outDir, `${originalName.replace(/[^A-Za-z0-9._-]/g, "_")}.extracted.txt`);
  fs.writeFileSync(textPath, text.slice(0, 400000), "utf8");
  const handleId = await ctx.handle("doc_text", { text: text.slice(0, maxChars), engine, originalName, sourcePath: tmpPath });
  ctx.findings.documents = [
    ...((ctx.findings.documents as unknown[]) ?? []),
    { name: originalName, engine, words, pages, path: textPath },
  ];
  if (ctx.input.uploadId) {
    try {
      await db
        .update(uploads)
        .set({ status: "EXTRACTED", extraction: { engine, words, pages, chars: text.length, preview: text.slice(0, 1200) } })
        .where(eq(uploads.id, String(ctx.input.uploadId)));
    } catch {
      /* non fatal */
    }
  }
  return {
    ok: true,
    summary: `Extracted ${words} words (${text.length} chars${pages ? `, ${pages} PDF pages` : ""}) from ${originalName} using ${engine}.`,
    agentMessage: `I extracted ${words} words from ${originalName} with ${engine}. The original file was not modified.`,
    output: { engine, words, chars: text.length, pages, preview: text.slice(0, 1500), textPath, handle: handleId, notes },
    artifacts: [{ kind: "extraction", name: path.basename(textPath), absPath: textPath, mime: "text/plain", meta: { words, pages, engine, source: originalName } }],
  };
};

const docAnalyse: ToolHandler = async (ctx) => {
  let text = String(ctx.input.text ?? "");
  if (!text && ctx.input.textId) {
    const stored = await ctx.loadHandle<{ text: string }>(String(ctx.input.textId));
    text = stored?.text ?? "";
  }
  if (!text && ctx.findings.documents) {
    const first = (ctx.findings.documents as { path: string }[])[0];
    if (first && fs.existsSync(first.path)) text = fs.readFileSync(first.path, "utf8");
  }
  if (!text) return fail("No text available to analyse. Provide text, a text handle, or run doc.extract first.", "NO_TEXT");

  const stopwords = new Set(
    "the a an and or of to in for on with by is are was were be been this that these those it its as at from not but if then than into over under more most other such no nor only own same so too very can will just about above after again against all any because before being below between during few further here how i its me my myself our ours ourselves out she should some them themselves they their theirs then there through until up while who whom why you your yours yourself yourselves we us".split(
      /\s+/,
    ),
  );
  const tokens = text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
  const filtered = tokens.filter((token) => !stopwords.has(token));
  const frequency = new Map<string, number>();
  for (const token of filtered) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  const bigrams = new Map<string, number>();
  for (let i = 1; i < filtered.length; i += 1) {
    const gram = `${filtered[i - 1]} ${filtered[i]}`;
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }
  const rankedBigrams = Array.from(bigrams.entries())
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([phrase, count]) => ({ phrase, count }));
  const sentenceList = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const numbers = Array.from(text.matchAll(/\b\d[\d,.]*\b/g)).map((m) => m[0]);
  const dates = Array.from(text.matchAll(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})\b/g)).map((m) => m[0]);
  const urls = Array.from(new Set(Array.from(text.matchAll(/https?:\/\/[^\s)"']+/g)).map((m) => m[0]))).slice(0, 30);
  const emails = Array.from(new Set(Array.from(text.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)).map((m) => m[0]))).slice(0, 20);

  const avgSentence = sentenceList.length > 0 ? Number((filtered.length / sentenceList.length).toFixed(1)) : 0;
  const lexicalDiversity = tokens.length > 0 ? Number((new Set(tokens).size / tokens.length).toFixed(3)) : 0;

  const analysis = {
    chars: text.length,
    words: filtered.length,
    sentences: sentenceList.length,
    paragraphs: paragraphs.length,
    avgWordsPerSentence: avgSentence,
    lexicalDiversity,
    topTerms: Array.from(frequency.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([term, count]) => ({ term, count })),
    keyPhrases: rankedBigrams,
    numbers: numbers.slice(0, 40),
    dates: Array.from(new Set(dates)).slice(0, 25),
    urls,
    emails,
    longestSentences: sentenceList.slice().sort((a, b) => b.length - a.length).slice(0, 5).map((s) => s.slice(0, 320)),
  };

  let narrative = `The document contains ${analysis.words} words across ${analysis.sentences} sentences and ${analysis.paragraphs} paragraphs. Average sentence length is ${analysis.avgWordsPerSentence} words with a lexical diversity of ${analysis.lexicalDiversity}. The dominant subject matter is ${analysis.topTerms.slice(0, 4).map((t) => t.term).join(", ")}.`;
  if (analysis.urls.length > 0) narrative += ` ${analysis.urls.length} external references are present and were captured as citable links.`;
  if (analysis.dates.length > 0) narrative += ` Key dates detected: ${analysis.dates.slice(0, 5).join(", ")}.`;
  narrative += analysis.lexicalDiversity < 0.3 ? " Repetition is high — the wording is repetitive relative to its length." : " Wording is varied throughout.";

  const analysisDir = ensureDir(path.join(ctx.runDir, "analysis"));
  const jsonPath = path.join(analysisDir, "document_analysis.json");
  fs.writeFileSync(jsonPath, JSON.stringify(analysis, null, 2), "utf8");
  const mdPath = path.join(analysisDir, "document_analysis.md");
  const md = [
    `# Document analysis`,
    "",
    `Question focus: ${ctx.input.question ? String(ctx.input.question) : "(general)"}`,
    "",
    narrative,
    "",
    "## Top terms",
    ...analysis.topTerms.slice(0, 12).map((t) => `- **${t.term}** — ${t.count}`),
    "",
    "## Key phrases",
    ...analysis.keyPhrases.map((p) => `- ${p.phrase} (${p.count})`),
    "",
    "## Extracted links",
    ...analysis.urls.slice(0, 15).map((u) => `- ${u}`),
  ].join("\n");
  fs.writeFileSync(mdPath, md, "utf8");
  const handleId = await ctx.handle("doc_analysis", analysis);

  return {
    ok: true,
    summary: narrative,
    agentMessage: `Analysis complete: ${analysis.words} words, ${analysis.sentences} sentences, ${analysis.urls.length} references.`,
    output: { ...analysis, handle: handleId, analysisPath: mdPath },
    artifacts: [
      { kind: "analysis", name: "document_analysis.json", absPath: jsonPath, mime: "application/json", meta: analysis as unknown as Record<string, unknown>, validated: true },
      { kind: "analysis", name: "document_analysis.md", absPath: mdPath, mime: "text/markdown" },
    ],
  };
};

const supervisorAnswer: ToolHandler = async (ctx) => {
  const question = String(ctx.input.question);
  const context = (ctx.input.context as string[]) ?? [];
  const system =
    "You are AISHA, the Master Supervisor of AI-EXECUTIVE, a local desktop agent OS. Answer concisely and operationally. Never invent facts, files, sources or results. If evidence is missing, say so plainly.";
  const prompt = context.length > 0 ? `Question: ${question}\n\nVerified evidence gathered by the team:\n${context.map((c) => `- ${c}`).join("\n")}` : `Question: ${question}`;
  const attempt = await askModel(prompt, system, ctx.signal);
  if (attempt.ok && attempt.text.trim().length > 0) {
    return ok(
      attempt.text.trim().slice(0, 4000),
      { engine: attempt.engine, model: attempt.model, latencyMs: attempt.latencyMs, answer: attempt.text.trim() },
      attempt.text.trim().slice(0, 200),
    );
  }
  const deterministic = context.length > 0
    ? `Here is what the team actually established: ${context.slice(0, 5).join(" ")}${question ? ` Regarding your question — "${question}" — that evidence above is the basis I can stand behind right now.` : ""}`
    : `I have no local model configured, so I will not invent an answer. Install Ollama (free, offline) and set OLLAMA_MODEL, or ask me to run a concrete task — research, file work, document analysis or video production — and I will execute it with real tools.`;
  return ok(deterministic, { engine: "deterministic-local", llmError: attempt.error, answer: deterministic });
};

const artifactRegister: ToolHandler = async (ctx) => {
  const target = String(ctx.input.path);
  if (!fs.existsSync(target)) return fail(`File not found: ${target}`, "ENOENT");
  const stat = fs.statSync(target);
  return {
    ok: true,
    summary: `Registered ${target} (${humanSize(stat.size)}) as a ${String(ctx.input.kind)} artifact`,
    output: { path: target, size: stat.size },
    artifacts: [{ kind: String(ctx.input.kind), name: path.basename(target), absPath: target, meta: { registeredBy: ctx.agentId } }],
  };
};

export const KNOWLEDGE_TOOLS: Record<string, ToolHandler> = {
  "research.search": researchSearch,
  "browser.fetch": browserFetch,
  "research.verify": researchVerify,
  "doc.extract": docExtract,
  "doc.analyse": docAnalyse,
  "supervisor.answer": supervisorAnswer,
  "artifact.register": artifactRegister,
};
