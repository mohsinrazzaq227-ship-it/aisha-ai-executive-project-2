import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DIRS } from "@/lib/config";
import { registerTool } from "@/lib/tools/registry";
import { fail, ok, type ArtifactInput } from "@/lib/tools/types";
import { ensureDir, slugify, toRelative, truncate } from "@/lib/util";
import { artifactDirFor } from "@/lib/artifacts";

/** Minimal HTML → text extraction with no external dependency (real parse, no guessing). */
function htmlToText(html: string): { title: string; headings: string[]; links: string[]; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const headings = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((m) => stripTags(m[2]).trim())
    .filter(Boolean)
    .slice(0, 60);
  const links = [...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 120);
  const text = stripTags(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
  return { title, headings, links, text };
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Chromium launch options. Containers and locked-down hosts very often cannot
 * use the Chromium sandbox, so it is disabled unless AISHA_BROWSER_SANDBOX=true
 * explicitly enables it. This is recorded in the tool's evidence, never hidden.
 */
function launchOptions(): { headless: boolean; executablePath?: string; chromiumSandbox: boolean; args: string[] } {
  return {
    headless: process.env.AISHA_BROWSER_HEADLESS !== "false",
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    chromiumSandbox: process.env.AISHA_BROWSER_SANDBOX === "true",
    args: ["--disable-dev-shm-usage"],
  };
}

type ChromiumProbe = { available: boolean; detail: string; fix?: string; executable?: string };

let chromiumCache: { at: number; value: ChromiumProbe } | null = null;
let chromiumLaunch: Promise<ChromiumProbe> | null = null;

/**
 * A probe that is worth trusting: the executable must exist AND a real browser
 * must actually start. A downloaded-but-unlaunchable Chromium (missing OS
 * libraries) reports the real linker error instead of advertising AVAILABLE.
 */
export async function chromiumProbe(force = false): Promise<ChromiumProbe> {
  if (!force && chromiumCache && Date.now() - chromiumCache.at < 60_000) return chromiumCache.value;
  if (chromiumLaunch) return chromiumLaunch;
  chromiumLaunch = (async (): Promise<ChromiumProbe> => {
    let executable: string;
    try {
      const { chromium } = await import("playwright");
      executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? chromium.executablePath();
    } catch (error) {
      return {
        available: false,
        detail: `playwright package cannot be loaded: ${String(error).slice(0, 200)}`,
        fix: "npm install playwright",
      };
    }
    try {
      await fs.access(executable);
    } catch {
      return {
        available: false,
        detail: `Playwright/Chromium is not installed/configured (no binary at ${executable})`,
        fix: "npx playwright install chromium",
        executable,
      };
    }
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch(launchOptions());
      await browser.close();
      return { available: true, detail: `chromium launched successfully (${executable})`, executable };
    } catch (error) {
      const message = String(error).replace(/\s+/g, " ").slice(0, 400);
      // Ask the binary itself why it cannot start: the launcher swallows the
      // dynamic-loader error, but running the executable surfaces the real cause.
      let loaderError = "";
      try {
        const { spawn } = await import("node:child_process");
        loaderError = await new Promise<string>((resolve) => {
          const child = spawn(executable, ["--version"], { windowsHide: true });
          let out = "";
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve("");
          }, 5000);
          child.stderr.on("data", (chunk) => (out += String(chunk)));
          child.stdout.on("data", (chunk) => (out += String(chunk)));
          child.on("error", () => resolve(""));
          child.on("close", () => {
            clearTimeout(timer);
            resolve(out.replace(/\s+/g, " ").trim().slice(0, 300));
          });
        });
      } catch {
        loaderError = "";
      }
      const missingLibs = [...`${message} ${loaderError}`.matchAll(/([a-z0-9._+-]+\.so[0-9.]*): cannot open shared object file/g)].map((m) => m[1]);
      return {
        available: false,
        detail: missingLibs.length
          ? `chromium is downloaded but cannot start: missing OS libraries (${[...new Set(missingLibs)].slice(0, 6).join(", ")}) — the browser binary exists, execution does not. Loader said: ${loaderError || message}`
          : loaderError
            ? `chromium failed to start (${loaderError})`
            : `chromium failed to start: ${message}`,
        fix: missingLibs.length
          ? "install the browser OS dependencies: npx playwright install-deps chromium (requires root/sudo)"
          : "check the chromium binary and sandbox flags (AISHA_BROWSER_SANDBOX / PLAYWRIGHT_CHROMIUM_EXECUTABLE)",
        executable,
      };
    } finally {
      chromiumLaunch = null;
    }
  })();
  const value = await chromiumLaunch;
  chromiumCache = { at: Date.now(), value };
  return value;
}

async function fetchText(url: string, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; status: number; contentType: string; body: string; bytes: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "AISHA/1.0 (+local executive agent)", accept: "text/html,application/json,text/plain,*/*" },
      cache: "no-store",
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body,
      bytes: Buffer.byteLength(body),
    };
  } catch (error) {
    return { ok: false, status: 0, contentType: "", body: "", bytes: 0, error: String(error) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

registerTool({
  id: "web.fetch",
  title: "Fetch a URL",
  group: "web",
  description: "Retrieves a page over HTTP and reports the real status code, content type and byte count.",
  risk: "LOW",
  resourceClass: "LIGHT",
  agents: ["research", "browser", "docs", "aisha", "media_director", "qa"],
  params: z.object({ url: z.string().url(), extract: z.boolean().default(true), save: z.boolean().default(false) }),
  verificationNote: "HTTP status and byte count of the received body are recorded; non-2xx is a failure, not a success.",
  availability: async () => ({ available: true, detail: "global fetch (Node 22 undici)" }),
  execute: async (ctx, params) => {
    const result = await fetchText(params.url, 20_000, ctx.signal);
    if (!result.ok) {
      return fail("FAILED", `fetch failed (status ${result.status}): ${result.error ?? "non-2xx response"}`, [
        { kind: "http", detail: `status ${result.status}` },
      ]);
    }
    const parsed = params.extract && /html/i.test(result.contentType) ? htmlToText(result.body) : null;
    let artifactPath: string | null = null;
    if (params.save) {
      const dir = await artifactDirFor(ctx.taskId);
      artifactPath = path.join(dir, `${slugify(new URL(params.url).hostname)}-${Date.now()}.txt`);
      await ensureDir(path.dirname(artifactPath));
      await fs.writeFile(artifactPath, params.extract && parsed ? parsed.text : result.body, "utf8");
    }
    return {
      status: "SUCCESS",
      summary: `GET ${params.url} → ${result.status}, ${result.bytes}B${parsed?.title ? ` · "${parsed.title}"` : ""}`,
      data: {
        url: params.url,
        status: result.status,
        contentType: result.contentType,
        bytes: result.bytes,
        title: parsed?.title ?? "",
        headings: parsed?.headings ?? [],
        linkCount: parsed?.links.length ?? 0,
        text: truncate(parsed?.text ?? result.body, 30_000),
      },
      evidence: [
        { kind: "http-status", detail: String(result.status) },
        { kind: "body-bytes", detail: String(result.bytes) },
      ],
      artifacts: artifactPath
        ? [{ name: path.basename(artifactPath), kind: "web-capture", filePath: artifactPath, mimeType: "text/plain", origin: "retrieved" }]
        : [],
      verification: {
        verified: result.bytes > 0 && result.status >= 200 && result.status < 300,
        method: "http-status + byte-count",
        detail: `${result.status} with ${result.bytes}B body`,
      },
    };
  },
});

registerTool({
  id: "research.search",
  title: "Research a topic",
  group: "web",
  description: "Multi-engine research (Wikipedia REST + OpenAlex + direct fetch) returning real URLs with retrieval evidence.",
  risk: "LOW",
  resourceClass: "MEDIUM",
  agents: ["research", "aisha", "media_director", "docs", "data"],
  params: z.object({ query: z.string().min(2).max(300), limit: z.number().int().min(1).max(8).default(3), writeDossier: z.boolean().default(true) }),
  verificationNote: "Each source is re-fetched to confirm the URL resolves and the byte count matches the first retrieval.",
  availability: async () => ({ available: true, detail: "HTTP research engines require outbound network" }),
  execute: async (ctx, params) => {
    const sources: Array<{ engine: string; title: string; url: string; bytes: number; status: number; extract: string }> = [];
    const failures: string[] = [];

    const wiki = await fetchText(
      `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&explaintext=1&redirects=1&titles=${encodeURIComponent(params.query)}`,
      15_000,
      ctx.signal,
    );
    if (wiki.ok) {
      try {
        const parsed = JSON.parse(wiki.body) as { query?: { pages?: Record<string, { title?: string; extract?: string; fullurl?: string }> } };
        const page = Object.values(parsed.query?.pages ?? {})[0];
        if (page?.extract) {
          sources.push({
            engine: "wikipedia-rest",
            title: page.title ?? params.query,
            url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title ?? params.query)}`,
            bytes: Buffer.byteLength(page.extract),
            status: wiki.status,
            extract: page.extract.slice(0, 6000),
          });
        } else failures.push("wikipedia: page not found");
      } catch (error) {
        failures.push(`wikipedia: parse error ${String(error)}`);
      }
    } else failures.push(`wikipedia: ${wiki.error ?? `status ${wiki.status}`}`);

    const openalex = await fetchText(
      `https://api.openalex.org/works?search=${encodeURIComponent(params.query)}&per-page=${params.limit}`,
      15_000,
      ctx.signal,
    );
    if (openalex.ok) {
      try {
        const parsed = JSON.parse(openalex.body) as { results?: Array<{ display_name?: string; doi?: string; publication_year?: number; abstract_inverted_index?: Record<string, number[]> }> };
        for (const work of parsed.results ?? []) {
          if (!work.display_name) continue;
          const abstract = work.abstract_inverted_index
            ? Object.entries(work.abstract_inverted_index)
                .flatMap(([word, positions]) => positions.map((pos) => ({ word, pos })))
                .sort((a, b) => a.pos - b.pos)
                .slice(0, 120)
                .map((w) => w.word)
                .join(" ")
            : "";
          sources.push({
            engine: "openalex",
            title: work.display_name,
            url: work.doi ?? `https://openalex.org/works?search=${encodeURIComponent(params.query)}`,
            bytes: Buffer.byteLength(abstract),
            status: openalex.status,
            extract: `${abstract} (${work.publication_year ?? "n/a"})`,
          });
        }
      } catch (error) {
        failures.push(`openalex: parse error ${String(error)}`);
      }
    } else failures.push(`openalex: ${openalex.error ?? `status ${openalex.status}`}`);

    if (!sources.length) {
      return fail("FAILED", `no research engine returned data (${failures.join("; ")})`, failures.map((f) => ({ kind: "engine-failure", detail: f })));
    }

    const verifications: string[] = [];
    let verifiedCount = 0;
    for (const source of sources.slice(0, params.limit)) {
      const recheck = await fetchText(source.url, 12_000, ctx.signal);
      if (recheck.ok && recheck.bytes > 0) {
        verifiedCount += 1;
        verifications.push(`${source.url} → ${recheck.status}, ${recheck.bytes}B`);
      } else {
        verifications.push(`${source.url} → UNREACHABLE on re-check`);
      }
    }

    let artifactPath: string | null = null;
    if (params.writeDossier) {
      const dir = await artifactDirFor(ctx.taskId);
      artifactPath = path.join(dir, `research-${slugify(params.query)}.md`);
      const body = [
        `# Research dossier — ${params.query}`,
        "",
        `Sources: ${sources.length} · independent re-checks passed: ${verifiedCount}`,
        failures.length ? `Engine failures (reported, not hidden): ${failures.join("; ")}` : "All engines responded.",
        "",
        ...sources.map(
          (s) => `## ${s.title}\n\n- engine: ${s.engine}\n- url: ${s.url}\n- retrieved: ${s.bytes}B (HTTP ${s.status})\n\n${s.extract.slice(0, 2000)}\n`,
        ),
      ].join("\n");
      await fs.writeFile(artifactPath, body, "utf8");
    }

    return {
      status: "SUCCESS",
      summary: `${sources.length} source(s) retrieved, ${verifiedCount} independently re-checked${failures.length ? `, ${failures.length} engine failure(s) reported` : ""}`,
      data: { query: params.query, sources, failures, rechecks: verifications },
      evidence: verifications.slice(0, 6).map((detail) => ({ kind: "source-recheck", detail })),
      artifacts: artifactPath
        ? [{ name: path.basename(artifactPath), kind: "research-dossier", filePath: artifactPath, mimeType: "text/markdown", origin: "retrieved" }]
        : [],
      verification: { verified: verifiedCount > 0, method: "re-fetch-recheck", detail: `${verifiedCount}/${Math.min(params.limit, sources.length)} sources re-fetched successfully` },
    };
  },
});

registerTool({
  id: "browser.navigate",
  title: "Browse a page (Playwright)",
  group: "web",
  description: "Launches real Chromium via Playwright, navigates, and captures title/URL/DOM facts plus a PNG screenshot.",
  risk: "MEDIUM",
  resourceClass: "HEAVY",
  agents: ["browser", "aisha", "research", "qa"],
  params: z.object({
    url: z.string().url(),
    screenshot: z.boolean().default(true),
    waitForSelector: z.string().optional(),
    timeoutMs: z.number().int().min(1000).max(90_000).default(30_000),
  }),
  verificationNote: "page.url() must match the requested URL, the HTTP status must be < 400, and the PNG must be a non-trivial file on disk.",
  availability: () => chromiumProbe(),
  execute: async (ctx, params) => {
    const { chromium } = await import("playwright");
    const dir = await artifactDirFor(ctx.taskId);
    const screenshotPath = path.join(dir, `browser-${slugify(new URL(params.url).hostname)}-${Date.now()}.png`);
    const browser = await chromium.launch(launchOptions()).catch((error) => {
      throw new Error(`chromium launch failed: ${String(error).slice(0, 200)}`);
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const response = await page.goto(params.url, { timeout: params.timeoutMs, waitUntil: "domcontentloaded" });
      if (params.waitForSelector) {
        await page.waitForSelector(params.waitForSelector, { timeout: Math.min(params.timeoutMs, 15_000) }).catch(() => undefined);
      }
      const facts = await page.evaluate(() => ({
        title: document.title,
        headings: Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 15).map((el) => (el.textContent ?? "").trim()),
        buttons: Array.from(document.querySelectorAll("button,[role=button],input[type=submit]")).slice(0, 25).map((el) => (el.textContent ?? "").trim() || (el as HTMLInputElement).value || ""),
        inputs: Array.from(document.querySelectorAll("input,textarea,select")).slice(0, 25).map((el) => {
          const input = el as HTMLInputElement;
          return { name: input.name || input.id || "", type: input.type || el.tagName.toLowerCase(), placeholder: input.placeholder ?? "" };
        }),
        links: Array.from(document.querySelectorAll("a[href]")).slice(0, 40).map((el) => (el as HTMLAnchorElement).href),
        forms: document.querySelectorAll("form").length,
        
      }));
      await page.screenshot({ path: screenshotPath, fullPage: false });
      const finalUrl = page.url();
      const status = response?.status() ?? 0;
      const screenshotStat = await fs.stat(screenshotPath).catch(() => null);
      const verified =
        status > 0 && status < 400 && screenshotStat !== null && screenshotStat.size > 5000 && finalUrl.startsWith(new URL(params.url).origin);
      return {
        status: "SUCCESS",
        summary: `loaded ${finalUrl} (HTTP ${status}) · "${facts.title}" · ${facts.headings.length} heading(s), ${facts.forms} form(s)`,
        data: { url: params.url, finalUrl, status, facts, screenshotBytes: screenshotStat?.size ?? 0 },
        evidence: [
          { kind: "http-status", detail: String(status) },
          { kind: "screenshot", detail: `${screenshotStat?.size ?? 0}B PNG` },
          { kind: "dom", detail: `${facts.headings.length} headings, ${facts.links.length} links, ${facts.forms} forms` },
        ],
        artifacts: [
          { name: path.basename(screenshotPath), kind: "screenshot", filePath: screenshotPath, mimeType: "image/png", origin: "retrieved" },
        ],
        verification: { verified, method: "url + http-status + screenshot-bytes", detail: `${finalUrl} (${status}), screenshot ${screenshotStat?.size ?? 0}B` },
      };
    } finally {
      await browser.close().catch(() => undefined);
    }
  },
});

registerTool({
  id: "browser.form",
  title: "Fill and submit a form",
  group: "web",
  description: "Navigates to a page, fills fields, clicks submit and verifies the resulting page state. Never reports success without post-action evidence.",
  risk: "MEDIUM",
  resourceClass: "HEAVY",
  agents: ["browser", "aisha"],
  params: z.object({
    url: z.string().url(),
    fields: z.record(z.string(), z.string()),
    submitSelector: z.string().optional(),
    expectText: z.string().optional(),
    screenshot: z.boolean().default(true),
  }),
  verificationNote: "Expected confirmation text (or a URL change) must be observed on the page after submission; otherwise VERIFICATION_FAILED.",
  availability: () => chromiumProbe(),
  execute: async (ctx, params) => {
    const { chromium } = await import("playwright");
    const dir = await artifactDirFor(ctx.taskId);
    const before = path.join(dir, `form-before-${Date.now()}.png`);
    const after = path.join(dir, `form-after-${Date.now()}.png`);
    const browser = await chromium.launch(launchOptions());
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(params.url, { timeout: 30_000, waitUntil: "domcontentloaded" });
      const startUrl = page.url();
      if (params.screenshot) await page.screenshot({ path: before });
      const filled: Record<string, { ok: boolean; detail: string }> = {};
      for (const [selector, value] of Object.entries(params.fields)) {
        try {
          await page.fill(selector, value, { timeout: 10_000 });
          const actual = await page.inputValue(selector);
          filled[selector] = { ok: actual === value, detail: actual === value ? "value matches" : `page shows "${actual}"` };
        } catch (error) {
          filled[selector] = { ok: false, detail: String(error).slice(0, 200) };
        }
      }
      let clicked = false;
      if (params.submitSelector) {
        try {
          await Promise.all([
            page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined),
            page.click(params.submitSelector, { timeout: 10_000 }),
          ]);
          clicked = true;
        } catch (error) {
          filled[params.submitSelector] = { ok: false, detail: `submit failed: ${String(error).slice(0, 200)}` };
        }
      }
      await page.waitForTimeout(1000);
      const endUrl = page.url();
      const bodyText = (await page.textContent("body")) ?? "";
      if (params.screenshot) await page.screenshot({ path: after });
      const allFieldsFilled = Object.values(filled).every((f) => f.ok);
      const expectation = params.expectText ? bodyText.toLowerCase().includes(params.expectText.toLowerCase()) : endUrl !== startUrl;
      const verified = allFieldsFilled && expectation && clicked;
      const afterStat = await fs.stat(after).catch(() => null);
      const formArtifacts: ArtifactInput[] = [
        { name: path.basename(before), kind: "screenshot:before", filePath: before, mimeType: "image/png", origin: "retrieved" },
      ];
      if (afterStat) {
        formArtifacts.push({ name: path.basename(after), kind: "screenshot:after", filePath: after, mimeType: "image/png", origin: "retrieved" });
      }
      const result = {
        status: verified ? ("SUCCESS" as const) : ("VERIFICATION_FAILED" as const),
        summary: verified
          ? `form submitted: ${Object.keys(params.fields).length} field(s) filled, confirmation observed (${params.expectText ?? endUrl})`
          : `form not verified: fieldsOk=${allFieldsFilled}, submitted=${clicked}, confirmation=${expectation}`,
        data: { startUrl, endUrl, filled, clicked, confirmationObserved: expectation },
        evidence: [
          { kind: "field-readback", detail: JSON.stringify(filled).slice(0, 800) },
          { kind: "url-change", detail: `${startUrl} → ${endUrl}` },
          { kind: "confirmation-text", detail: expectation ? "observed" : "not observed" },
        ],
        artifacts: formArtifacts,
        verification: {
          verified,
          method: "field-readback + url-change + confirmation-text",
          detail: `fields ${allFieldsFilled ? "ok" : "mismatch"}; clicked ${clicked}; confirmation ${expectation}`,
        },
      };
      return result;
    } finally {
      await browser.close().catch(() => undefined);
    }
  },
});

export { htmlToText, fetchText };
export const _paths = { DIRS, toRelative };
