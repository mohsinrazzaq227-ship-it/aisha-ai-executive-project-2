/**
 * Planner: intent → task DAG.
 *
 * Two engines, one output contract:
 *   1. OLLAMA      — local LLM proposes the graph (strict JSON, validated against
 *                    the real tool registry; hallucinated tools are dropped).
 *   2. DETERMINISTIC — a real, runnable graph built from the request text.
 * The engine that produced the plan is stored on the task, so the UI can never
 * present a deterministic plan as LLM reasoning.
 */
import { z } from "zod";
import type { ResourceClass, RiskLevel } from "@/db/schema";
import { DIRS } from "@/lib/config";
import { listTools, getTool } from "@/lib/tools";
import { AGENT_BY_ID } from "@/lib/agents";
import { chat, probe } from "@/lib/ollama";
import { classifyIncoming } from "@/lib/security";
import { newId, slugify, truncate } from "@/lib/util";

export type PlannedStep = {
  id: string;
  title: string;
  agentId: string;
  toolId: string;
  params: Record<string, unknown>;
  dependsOn: string[];
  parallel: boolean;
  resourceClass: ResourceClass;
  risk: RiskLevel;
  rationale: string;
};

export type Plan = {
  intent: Intent;
  engine: "OLLAMA" | "DETERMINISTIC";
  summary: string;
  steps: PlannedStep[];
  notes: string[];
  model: string | null;
};

export const INTENTS = ["RESEARCH", "DOCUMENT", "MEDIA", "EMAIL", "DATA", "COMPUTER", "BROWSER", "SYSTEM", "GENERAL"] as const;
export type Intent = (typeof INTENTS)[number];

export function classifyIntent(request: string): Intent {
  const text = request.toLowerCase();
  if (/(email|inbox|mail |smtp|imap)/.test(text)) return "EMAIL";
  if (/(video|film|clip|storyboard|render|mp4|caption)/.test(text)) return "MEDIA";
  if (/(image|png|poster|card|visual|logo)/.test(text)) return "MEDIA";
  if (/(report|document|pdf|docx|xlsx|spreadsheet|write up|memo|markdown)/.test(text)) return "DOCUMENT";
  if (/(research|find out|compare|market|supplier|sources|citations|analyse the market)/.test(text)) return "RESEARCH";
  if (/(csv|json|dataset|statistics|sum|average|aggregate|numbers)/.test(text)) return "DATA";
  if (/(click|type|window|screenshot|screen|desktop|notepad|excel|open the app|ui automation|mouse|keyboard)/.test(text)) return "COMPUTER";
  if (/(website|browser|form|fill in|submit|webpage|login page|navigate)/.test(text)) return "BROWSER";
  if (/(run|command|shell|script|powershell|bash|process|diagnose|host|resource)/.test(text)) return "SYSTEM";
  return "GENERAL";
}

function extractTopic(request: string): string {
  return truncate(
    request
      .replace(/^(please|can you|could you|i need you to|i want you to|aisha,?)\s*/i, "")
      .replace(/\s+/g, " ")
      .trim(),
    220,
  );
}

function parseUrls(request: string): string[] {
  return [...request.matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0]).slice(0, 4);
}

function parseQuoted(request: string, keyword: string): string | null {
  const pattern = new RegExp(`${keyword}[^"']*["']([^"']{3,200})["']`, "i");
  return pattern.exec(request)?.[1] ?? null;
}

function extractDeliverables(request: string): { format: "pdf" | "docx" | "xlsx" | "md" | "csv" | "json" | "txt" } {
  const text = request.toLowerCase();
  if (/pdf/.test(text)) return { format: "pdf" };
  if (/word|docx/.test(text)) return { format: "docx" };
  if (/excel|xlsx|spreadsheet/.test(text)) return { format: "xlsx" };
  if (/csv/.test(text)) return { format: "csv" };
  if (/json/.test(text)) return { format: "json" };
  if (/markdown|\.md/.test(text)) return { format: "md" };
  return { format: "md" };
}

function step(partial: Omit<PlannedStep, "id" | "parallel" | "resourceClass" | "risk"> & { id?: string; parallel?: boolean; resourceClass?: ResourceClass; risk?: RiskLevel }): PlannedStep {
  const tool = getTool(partial.toolId);
  return {
    id: partial.id ?? newId("s"),
    title: partial.title,
    agentId: partial.agentId,
    toolId: partial.toolId,
    params: partial.params,
    dependsOn: partial.dependsOn,
    parallel: partial.parallel ?? false,
    resourceClass: partial.resourceClass ?? tool?.resourceClass ?? "LIGHT",
    risk: partial.risk ?? 0 > 1 ? "MEDIUM" : tool?.risk ?? "LOW",
    rationale: partial.rationale,
  };
}

/** Deterministic planner: always produces a genuinely runnable graph. */
/**
 * Real capability detection from the request text. Sections accumulate instead
 * of being mutually exclusive, so "research three suppliers, compare prices,
 * write a report and email it to me" genuinely becomes three parallel research
 * branches feeding an analyst, a document step and an approval-gated send.
 */
function requestedSections(request: string, intent: Intent) {
  const text = request.toLowerCase();
  return {
    research: intent === "RESEARCH" || intent === "DOCUMENT" || intent === "GENERAL" || /(research|compare|supplier|market|find out|sources|citation)/.test(text),
    document: intent === "DOCUMENT" || intent === "RESEARCH" || /(report|document|pdf|docx|xlsx|spreadsheet|memo|write[- ]up|markdown|briefing)/.test(text),
    email: intent === "EMAIL" || /(email|e-mail|\bmail\b|send .* to )/.test(text),
    media: intent === "MEDIA" || /(video|film|clip|storyboard|render|mp4|caption|poster|image|png|visual)/.test(text),
    browser: intent === "BROWSER" || parseUrls(request).length > 0,
    computer: intent === "COMPUTER" || /(click|type into|window|screenshot|desktop|notepad|ui automation|mouse|keyboard)/.test(text),
    data: intent === "DATA" || /(csv|json|dataset|statistics|average|aggregate|numbers|analyse the)/.test(text),
    system: intent === "SYSTEM" || /(diagnostic|host|process list|shell|command|script|powershell|resource)/.test(text),
  };
}

export function deterministicPlan(request: string): Plan {
  const intent = classifyIntent(request);
  const topic = extractTopic(request);
  const urls = parseUrls(request);
  const wanted = requestedSections(request, intent);
  const notes: string[] = [];
  const steps: PlannedStep[] = [];

  const research = (label: string, index: number, dependency: string | null = null) => {
    const id = newId("s");
    steps.push(
      step({
        id,
        title: label,
        agentId: "research",
        toolId: "research.search",
        params: { query: label, limit: 3, writeDossier: true },
        dependsOn: dependency ? [dependency] : [],
        parallel: dependency ? false : true,
        rationale: `Real engine retrieval for "${label}" (${index === 0 ? "primary" : "parallel branch"})`,
      }),
    );
    return id;
  };

  let reportStepId: string | null = null;

  if (wanted.research) {
    const queries = splitQueries(topic);
    const researchIds = queries.map((query, index) => research(query, index));
    const analystId = newId("s");
    steps.push(
      step({
        id: analystId,
        title: "Synthesise findings into an executive report",
        agentId: "docs",
        toolId: "report.write",
        params: {
          title: `Executive briefing — ${truncate(topic, 80)}`,
          sections: researchIds.map((_, index) => ({
            heading: `Finding ${index + 1}: ${queries[index]}`,
            body: `Evidence gathered from the research branch for "${queries[index]}". References are recorded in the research dossier artifact.`,
          })),
          alsoPdf: extractDeliverables(request).format === "pdf",
        },
        dependsOn: researchIds,
        rationale: "Document agent composes the deliverable from real branch outputs",
      }),
    );
    reportStepId = analystId;
    if (wanted.document && extractDeliverables(request).format !== "md") {
      steps.push(
        step({
          id: newId("s"),
          title: "Produce the requested document format",
          agentId: "docs",
          toolId: "doc.generate",
          params: {
            title: `Executive briefing — ${truncate(topic, 80)}`,
            format: extractDeliverables(request).format,
            sections: [{ heading: "Summary", body: `Deliverable compiled from research branches for: ${topic}` }],
          },
          dependsOn: [analystId],
          rationale: `User asked for ${extractDeliverables(request).format.toUpperCase()} output`,
        }),
      );
    }
  }

  if (wanted.document && !wanted.research) {
    const id = newId("s");
    steps.push(
      step({
        id,
        title: "Produce the requested document",
        agentId: "docs",
        toolId: "doc.generate",
        params: {
          title: truncate(topic, 80),
          format: extractDeliverables(request).format,
          sections: [{ heading: "Summary", body: `Deliverable compiled for: ${topic}` }],
        },
        dependsOn: [],
        rationale: "Document agent generates and structurally validates the real file",
      }),
    );
    reportStepId = id;
  }

  if (wanted.browser) {
    const target = urls[0] ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(topic)}`;
    steps.push(
      step({
        id: newId("s"),
        title: `Browse and inspect ${target}`,
        agentId: "browser",
        toolId: "browser.navigate",
        params: { url: target, screenshot: true },
        dependsOn: [],
        rationale: "Playwright navigation with screenshot + DOM evidence",
      }),
    );
    notes.push("Form filling requires an explicit URL and selectors; ask AISHA to fill a specific form if that is the goal.");
  }

  if (wanted.computer) {
    steps.push(
      step({
        id: newId("s"),
        title: "Enumerate visible windows",
        agentId: "computer",
        toolId: "computer.windows",
        params: { action: "list" },
        dependsOn: [],
        rationale: "Computer agent reads the real window tree first",
      }),
    );
    steps.push(
      step({
        id: newId("s"),
        title: "Capture the screen",
        agentId: "computer",
        toolId: "computer.capture_screen",
        params: { label: slugify(topic) },
        dependsOn: [],
        rationale: "Pre-action screenshot as evidence baseline",
      }),
    );
    notes.push("UI Automation and synthetic input are exposed through computer.uia / computer.input and are only executable on a Windows host with the sidecar installed.");
  }

  if (wanted.data) {
    steps.push(
      step({
        id: newId("s"),
        title: "Analyse the dataset",
        agentId: "data",
        toolId: "data.analyze",
        params: { path: "datasets/sample.csv", writeSummary: true },
        dependsOn: [],
        rationale: "Data agent parses and aggregates with an independent recount",
      }),
    );
    notes.push("Point AISHA at a concrete dataset path (workspace-relative) for a real analysis run.");
  }

  if (wanted.media) {
    const briefId = newId("s");
    steps.push(
      step({
        id: briefId,
        title: "Write the creative brief",
        agentId: "media_director",
        toolId: "media.brief",
        params: { topic, durationSeconds: 30 },
        dependsOn: [],
        rationale: "Media director records the provider decision before rendering",
      }),
    );
    const cardsId = newId("s");
    steps.push(
      step({
        id: cardsId,
        title: "Compose scene cards",
        agentId: "image",
        toolId: "media.cards",
        params: {
          title: truncate(topic, 60),
          scenes: [
            { heading: "Cold open", body: truncate(topic, 220) },
            { heading: "Why it matters", body: "Deterministic scene cards produced locally with the native PNG composer." },
            { heading: "Close", body: "Rendered by AISHA without any AI image provider." },
          ],
        },
        dependsOn: [briefId],
        rationale: "Image agent composes real PNG scenes (origin recorded as deterministic)",
      }),
    );
    steps.push(
      step({
        id: newId("s"),
        title: "Render the video and validate it",
        agentId: "video",
        toolId: "media.video",
        params: {
          title: truncate(topic, 60),
          scenes: [
            { heading: "Cold open", body: truncate(topic, 200), seconds: 4 },
            { heading: "Why it matters", body: "Deterministic ffmpeg render, validated by ffprobe.", seconds: 4 },
            { heading: "Close", body: "No AI video provider was used.", seconds: 4 },
          ],
        },
        dependsOn: [cardsId],
        rationale: "Video agent renders MP4 and proves it with ffprobe; reports UNAVAILABLE if ffmpeg is missing",
      }),
    );
  }

  if (wanted.email) {
    steps.push(
      step({
        id: newId("s"),
        title: "List recent inbox messages",
        agentId: "email",
        toolId: "email.inbox",
        params: { limit: 5 },
        dependsOn: [],
        rationale: "Real IMAP read; reports MISCONFIGURED if IMAP_URL is unset",
      }),
    );
    const recipient = parseQuoted(request, "to") ?? process.env.EMAIL_DEFAULT_TO ?? null;
    if (recipient) {
      const draftId = newId("s");
      steps.push(
        step({
          id: draftId,
          title: `Draft the email to ${recipient}`,
          agentId: "email",
          toolId: "email.draft",
          params: { to: recipient, subject: truncate(topic, 120), body: `AISHA drafted this message from your request:\n\n${topic}` },
          dependsOn: [],
          rationale: "Drafts are safe artifacts; sending is a separate approval-gated step",
        }),
      );
      steps.push(
        step({
          id: newId("s"),
          title: `Send the email to ${recipient} (requires approval)`,
          agentId: "email",
          toolId: "email.send",
          params: { to: recipient, subject: truncate(topic, 120), body: `AISHA drafted this message from your request:\n\n${topic}` },
          dependsOn: [...(reportStepId ? [reportStepId] : []), draftId],
          risk: "HIGH",
          rationale: "HIGH risk: the execution path blocks until a human approval token is granted",
        }),
      );
    } else {
      notes.push("No recipient found in the request (or EMAIL_DEFAULT_TO); AISHA will not invent an address. Phrase it as: send an email to \"someone@example.com\" saying …");
    }
  }

  if (wanted.system) {
    steps.push(
      step({
        id: newId("s"),
        title: "Host diagnostics",
        agentId: "ops",
        toolId: "system.host",
        params: {},
        dependsOn: [],
        rationale: "Ops agent establishes the real host baseline first",
      }),
    );
    steps.push(
      step({
        id: newId("s"),
        title: "Resource snapshot",
        agentId: "ops",
        toolId: "system.resources",
        params: {},
        dependsOn: [],
        parallel: true,
        rationale: "Resource pressure determines HEAVY-step admission",
      }),
    );
    steps.push(
      step({
        id: newId("s"),
        title: "Validated shell execution",
        agentId: "code",
        toolId: "system.shell",
        params: { command: "echo AISHA shell check", timeoutMs: 10_000 },
        dependsOn: [],
        rationale: "Technical agent runs a validated command and reports the real exit code",
      }),
    );
  }

  if (!steps.length) {
    steps.push(
      step({
        id: newId("s"),
        title: "Host diagnostics (baseline)",
        agentId: "ops",
        toolId: "system.host",
        params: {},
        dependsOn: [],
        rationale: "No executable capability matched the request; AISHA establishes a verified baseline and reports the limitation instead of pretending",
      }),
    );
    notes.push("This request did not map to an execution plan; AISHA returns a grounded answer plus host evidence.");
  }

  const intentLabel: Record<Intent, string> = {
    RESEARCH: "multi-branch research with synthesised report",
    DOCUMENT: "research + document production",
    MEDIA: "media planning and deterministic render",
    EMAIL: "inbox review, draft and approval-gated send",
    DATA: "dataset analysis",
    COMPUTER: "computer observation and control",
    BROWSER: "browser navigation and inspection",
    SYSTEM: "host diagnostics and validated execution",
    GENERAL: "grounded general assistance",
  };

  const sections = Object.entries(wanted)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  return {
    intent,
    engine: "DETERMINISTIC",
    summary: `${intentLabel[intent]}: ${steps.length} step(s), ${steps.filter((s) => s.dependsOn.length === 0).length} independent branch(es) [sections: ${sections.join("+")}]`,
    steps,
    notes,
    model: null,
  };
}

function splitQueries(topic: string): string[] {
  const parts = topic
    .split(/\s+and\s+|,\s*|;\s*/)
    .map((part) => part.replace(/^(research|compare|find|analyse|analyze)\s+/i, "").trim())
    .filter((part) => part.length > 3);
  const cleaned = parts.length > 1 ? parts.slice(0, 3) : [topic];
  return cleaned.map((part) => truncate(part, 120));
}

const LlmPlanSchema = z.object({
  intent: z.string(),
  steps: z
    .array(
      z.object({
        title: z.string(),
        agent: z.string(),
        tool: z.string(),
        params: z.record(z.string(), z.unknown()).default({}),
        depends_on_titles: z.array(z.string()).default([]),
        rationale: z.string().default(""),
      }),
    )
    .min(1)
    .max(10),
  notes: z.array(z.string()).default([]),
});

export async function plan(request: string, opts: { signal?: AbortSignal } = {}): Promise<Plan> {
  const fallback = deterministicPlan(request);
  const status = await probe();
  if (status.status !== "AVAILABLE" || !status.selectedModel) {
    return { ...fallback, notes: [...fallback.notes, `Ollama unavailable (${status.detail}); deterministic planner used.`] };
  }

  const catalog = listTools().map((tool) => ({
    id: tool.id,
    group: tool.group,
    risk: tool.risk,
    resource: tool.resourceClass,
    agents: tool.agents,
    params: describeParams(tool.id),
    description: tool.description,
  }));

  const systemPrompt = [
    "You are the planning component of AISHA, a Windows AI executive.",
    "Return ONLY JSON matching: {\"intent\":string,\"steps\":[{\"title\":string,\"agent\":string,\"tool\":string,\"params\":object,\"depends_on_titles\":string[],\"rationale\":string}],\"notes\":string[]}.",
    "Rules: use ONLY tool ids from the catalog; only agents listed for that tool; keep params valid; independent steps must not depend on each other (they will run in parallel); never invent URLs or file paths; add a qa.verify step for anything that must be proven.",
    `Tool catalog: ${JSON.stringify(catalog).slice(0, 14_000)}`,
  ].join("\n");

  const result = await chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Request: ${request}\nWorkspace root: ${DIRS.workspace}` },
    ],
    { json: true, signal: opts.signal, model: status.selectedModel, timeoutMs: 90_000 },
  );

  if (!result.ok) {
    return { ...fallback, notes: [...fallback.notes, `Ollama plan call failed (${result.detail}); deterministic planner used.`] };
  }

  try {
    const parsed = LlmPlanSchema.parse(JSON.parse(result.content));
    const titleToId = new Map<string, string>();
    const steps: PlannedStep[] = [];
    const dropped: string[] = [];
    for (const candidate of parsed.steps) {
      const tool = getTool(candidate.tool);
      if (!tool || !tool.agents.includes(candidate.agent) || !AGENT_BY_ID.has(candidate.agent)) {
        dropped.push(`${candidate.tool} (agent ${candidate.agent})`);
        continue;
      }
      const id = newId("s");
      titleToId.set(candidate.title, id);
      steps.push({
        id,
        title: candidate.title.slice(0, 160),
        agentId: candidate.agent,
        toolId: tool.id,
        params: candidate.params,
        dependsOn: [],
        parallel: false,
        resourceClass: tool.resourceClass,
        risk: tool.risk,
        rationale: candidate.rationale || "planned by local model",
      });
    }
    if (!steps.length) {
      return { ...fallback, notes: [...fallback.notes, `LLM plans referenced unknown tools (${dropped.join(", ")}); deterministic planner used.`] };
    }
    for (const [index, candidate] of parsed.steps.entries()) {
      const target = steps[index];
      if (!target) continue;
      target.dependsOn = candidate.depends_on_titles.map((title) => titleToId.get(title)).filter((v): v is string => Boolean(v));
      target.parallel = target.dependsOn.length === 0 && steps.filter((s) => s.dependsOn.length === 0).length > 1;
    }
    const roots = steps.filter((s) => s.dependsOn.length === 0).length;
    return {
      intent: (INTENTS.includes(parsed.intent.toUpperCase() as Intent) ? (parsed.intent.toUpperCase() as Intent) : classifyIntent(request)),
      engine: "OLLAMA",
      summary: `local model ${result.model} planned ${steps.length} step(s) across ${roots} independent branch(es)`,
      steps,
      notes: [...parsed.notes, dropped.length ? `Dropped invalid tools: ${dropped.join(", ")}` : ""].filter(Boolean),
      model: result.model,
    };
  } catch (error) {
    return { ...fallback, notes: [...fallback.notes, `LLM plan was not valid JSON for the schema (${String(error).slice(0, 160)}); deterministic planner used.`] };
  }
}

function describeParams(toolId: string): string {
  const tool = getTool(toolId);
  if (!tool) return "{}";
  try {
    const shape = (tool.params as unknown as { _def?: { shape?: () => Record<string, unknown> } })._def?.shape?.();
    if (!shape) return "{}";
    return Object.keys(shape).join(", ");
  } catch {
    return "{}";
  }
}

export { classifyIncoming };
