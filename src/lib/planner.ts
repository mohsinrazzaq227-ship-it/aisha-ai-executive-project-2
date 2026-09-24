import type { RiskLevel } from "@/db/schema";
import { getTool } from "@/lib/tools/registry";
import { THEMES } from "@/lib/textrender";

/**
 * Planning engine. A deterministic, auditable intent parser builds the plan,
 * classifies risk and builds the task graph (dependencies + parallel batches +
 * resource classes). When a local model (Ollama) is configured it is used for
 * prose generation; the plan records which engine actually planned. The tool
 * registry is always the final authority on tools, risk and approval.
 */

export type ResourceClass = "LIGHT" | "HEAVY";

export type PlannedStep = {
  title: string;
  detail: string;
  agentId: string;
  toolId: string;
  toolInput: Record<string, unknown>;
  risk: RiskLevel;
  requiresApproval: boolean;
  /** Zero-based indexes of steps that must complete before this one starts. */
  dependsOn?: number[];
  /** May run concurrently with other ready steps of the same resource class. */
  parallel?: boolean;
  /** HEAVY steps are serialised so the machine stays responsive. */
  resourceClass?: ResourceClass;
};

export type Plan = {
  intent: IntentKind;
  title: string;
  steps: PlannedStep[];
  engine: "deterministic_local" | "ollama" | "cloud";
  engineDetail: string;
  notes: string[];
  topic: string;
  destination?: string;
};

export type IntentKind =
  | "VIDEO_PRODUCTION"
  | "RESEARCH_REPORT"
  | "DOCUMENT_ANALYSIS"
  | "SHELL_COMMAND"
  | "FILE_OPERATION"
  | "EMAIL"
  | "DESKTOP_CONTROL"
  | "BROWSER_AUTOMATION"
  | "DIAGNOSTICS"
  | "GENERAL";

export type UploadHint = { id: string; originalName: string; mime: string };

const COMMAND_STOPWORDS = [
  "please", "can", "you", "aisha", "ai-executive", "executive", "make", "create", "produce", "generate", "render",
  "research", "find", "search", "the", "latest", "news", "about", "for", "me", "my", "and", "then", "save", "write",
  "report", "folder", "documents", "video", "clip", "second", "seconds", "minute", "minutes", "long", "professional",
  "comparing", "compare", "options", "tools", "available", "today", "summarising", "summarizing", "findings", "detailed",
  "on", "of", "a", "an", "to", "in", "with", "that", "explains", "explaining", "explainer",
];

function extractTopic(message: string): string {
  const quoted = /"([^"]{4,120})"/.exec(message)?.[1];
  if (quoted) return quoted.trim();
  const cleaned = message
    .replace(/[^A-Za-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !COMMAND_STOPWORDS.includes(word.toLowerCase()));
  const topic = cleaned.slice(0, 8).join(" ").trim();
  return topic.length >= 3 ? topic : message.slice(0, 80);
}

function extractDuration(message: string): number {
  const explicit = /(\d{1,3})\s*(?:-|\s)?\s*(?:second|sec\b|s\b)/i.exec(message);
  if (explicit) return Math.max(15, Math.min(600, Number(explicit[1])));
  const minutes = /(\d{1,2})\s*(?:-|\s)?\s*(?:minute|min\b)/i.exec(message);
  if (minutes) return Math.max(15, Math.min(600, Number(minutes[1]) * 60));
  const words: Record<string, number> = { one: 60, two: 120, three: 180, four: 240, five: 300, half: 30, ninety: 90, forty: 40, thirty: 30, sixty: 60 };
  const wordMatch = /(one|two|three|four|five|half|ninety|forty|thirty|sixty)[\s-]*(?:minute|second)/i.exec(message);
  if (wordMatch) {
    const base = words[wordMatch[1].toLowerCase()] ?? 60;
    return /minute/i.test(wordMatch[0]) ? base : Math.max(15, base);
  }
  return 60;
}

function extractCommand(message: string): string | null {
  const fenced = /```(?:\w+)?\n?([\s\S]+?)```/.exec(message)?.[1];
  if (fenced) return fenced.trim();
  const quoted = /["'`]([^"'`]{3,400})["'`]/.exec(message)?.[1];
  if (quoted && /[a-zA-Z]/.test(quoted)) return quoted.trim();
  const afterColon = /:\s*(.+)$/m.exec(message)?.[1];
  if (afterColon) return afterColon.trim();
  return null;
}

function extractUrl(message: string): string | null {
  const url = /https?:\/\/[^\s"'<>]+/i.exec(message)?.[0];
  if (url) return url;
  const bare = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})(\/[^\s"'<>]*)?/i.exec(message.replace(/(?:research|search|about|find|look up|navigate to|go to|open)\s+/gi, ""))?.[0];
  if (bare && !/\.(txt|md|csv|json|pdf|docx|xlsx|png|jpg|mp4|wav|mp3)$/i.test(bare)) return `https://${bare.replace(/\s.*$/, "")}`;
  return null;
}

/**
 * Natural-language location hints resolve to named roots instead of being taken
 * as literal folder names. "list the files in my documents folder" must resolve
 * to the Documents root, not to a directory called "my documents folder".
 */
export function normalizePathHint(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/^open\s+/i, "")
    .replace(/^(the|my)\s+/i, "");
  const lower = cleaned.toLowerCase();
  if (/^(documents?|docs)( folder)?$/.test(lower)) return "documents";
  if (/^(uploads?|attachments?)( folder)?$/.test(lower)) return "uploads";
  if (/^(workspace|data|project)( folder)?$/.test(lower)) return "workspace";
  if (/^(desktop|desk top)$/.test(lower)) return "desktop";
  if (/^(downloads?)$/.test(lower)) return "downloads";
  return cleaned;
}

function extractPathHint(message: string): string {
  const explicit = /([A-Za-z]:\\[^"'\n]+|\/(?:home|Users|tmp|var|app)[^"'\n]{0,120})/.exec(message)?.[0];
  if (explicit) return explicit.trim();
  const named = /(?:in|from|inside|at|into|to|open|find|read|list)\s+(?:the\s+|my\s+)?(documents?|docs|uploads?|attachments?|desktop|downloads?|workspace)(?:\s+folder)?/i.exec(message);
  if (named) return normalizePathHint(named[1]);
  const fileish = /([A-Za-z0-9._-]+\.(?:txt|md|csv|json|log|pdf|docx|xlsx|png|jpg|jpeg|mp4|wav|mp3))/.exec(message)?.[0];
  if (fileish) return fileish;
  return "documents";
}

type StepExtras = { dependsOn?: number[]; parallel?: boolean; resourceClass?: ResourceClass };

function step(toolId: string, title: string, detail: string, toolInput: Record<string, unknown>, agentOverride?: string, extras: StepExtras = {}): PlannedStep {
  const tool = getTool(toolId);
  return {
    title,
    detail,
    agentId: agentOverride ?? tool.defaultAgent,
    toolId,
    toolInput,
    risk: tool.risk,
    requiresApproval: tool.requiresApproval,
    dependsOn: extras.dependsOn ?? [],
    parallel: extras.parallel ?? false,
    resourceClass: extras.resourceClass ?? (tool.risk === "MEDIUM" && /render|narrate|visuals/.test(toolId) ? "HEAVY" : "LIGHT"),
  };
}

function wantsEmail(message: string): boolean {
  return /(email|e-mail|mail me|send .*mail|inbox)/i.test(message);
}

function wantsReportFile(message: string): boolean {
  return /(save|write|store|put).*(report|file|document)|report.*(documents|folder|file)/i.test(message);
}

export type PlanInput = {
  message: string;
  uploads: UploadHint[];
  llmEngine: "deterministic_local" | "ollama" | "cloud";
  llmDetail: string;
};

export function buildPlan(input: PlanInput): Plan {
  const message = input.message.trim();
  const lower = message.toLowerCase();
  const topic = extractTopic(message);
  const duration = extractDuration(message);
  const notes: string[] = [];
  const upload = input.uploads[0];

  // The deliverable must be a video: the creation verb has to target it, so that
  // "research local AI video generation and write a report" is NOT read as a video task.
  const videoDeliverable = /(?:create|make|produce|generate|render|build|edit|assemble)[^.!?]{0,50}?\b(video|reel|shorts?|clip|mp4)\b/i.test(message);
  const videoFollowUp = /\bvideo\b/i.test(lower) && /(summaris|summariz|report on|turn .* into)/i.test(lower);
  const researchReportIntent = /(report|research|compare|document(s)? folder|save)/i.test(lower) && !videoDeliverable;
  const isVideo = (videoDeliverable || videoFollowUp) && !researchReportIntent;
  const isShell = /(powershell|run this command|run the command|execute (this|the)|terminal|command prompt|run a command|cmd\b|bash\b)/i.test(lower);
  const isDiagnostics = /(doctor|diagnos|system check|health check|check (the )?system|what is wrong|status report|capabilit)/i.test(lower);
  const wantsBrowserInteraction = /(click|log ?in|fill (in )?the form|type into|submit the form|scroll|interactive|javascript)/i.test(lower);
  const wantsBrowser = /(browser|navigate to|open the (web ?site|page|url)|visit )/i.test(lower) || wantsBrowserInteraction;
  const wantsDesktop = /(open (the )?(app|application|program|notepad|calculator|explorer)|take a screenshot|clipboard|window|type .* into|press .* hotkey|focus (the )?app|desktop)/i.test(lower);
  const isEmailOnly = wantsEmail(message) && !isVideo && !/(report|research|video)/i.test(lower);
  const isDocument = Boolean(upload) || /(pdf|docx|spreadsheet|xlsx|csv|analyse (this|the) (file|document)|analyz|summari[sz]e (this|the) (file|document|pdf))/.test(lower);
  const isFile = /(list (the )?(files|folder|directory)|find (the )?file|read (the )?file|open (my )?documents|create (a )?file|copy |move |rename |delete )/.test(lower);
  const isResearch = /(research|search|find|look up|compare|latest|news|what is|who is|explain|investigate|report)/.test(lower);

  // ---------------- VIDEO PRODUCTION -------------------------------------------
  if (isVideo) {
    const steps: PlannedStep[] = [
      step("research.search", "Research the topic on live sources", `Gather real sources and citable facts about "${topic}" for a ${duration}s video.`, { query: topic, limit: 8 }, undefined, { parallel: true }),
      step("research.search", "Research a second angle", `Run a second, independent live query so the script is not built from a single source set.`, { query: `${topic} evidence data`, limit: 6 }, undefined, { parallel: true }),
      step("research.verify", "Cross-check claims against sources", "Reject anything the sources do not support before it enters the script.", { claims: [], sources: [] }, undefined, { dependsOn: [0, 1] }),
      step("director.brief", "Write the creative brief", `Define audience, platform, tone, visual style, scene count and pacing for a ${duration}s piece.`, { topic, durationSec: duration }, undefined, { dependsOn: [2] }),
      step("script.generate", "Write the narration script", "Grounded, non-repetitive, adult narration sized to the requested duration.", { topic, durationSec: duration }, undefined, { dependsOn: [3] }),
      step("storyboard.generate", "Storyboard the scenes", "One genuinely different visual representation per scene with camera moves and transitions.", { scriptId: "" }, undefined, { dependsOn: [4] }),
      step("visuals.render", "Render the frames", "Offline vector frames at 1080x1920 with measured caption layout.", { storyboardId: "" }, undefined, { dependsOn: [5], resourceClass: "HEAVY" }),
      step("audio.narrate", "Produce audio", "Narration when a local TTS provider is configured, otherwise a labelled score bed.", { storyboardId: "" }, undefined, { dependsOn: [5], resourceClass: "HEAVY" }),
      step("audio.align", "Align timings", "Word-level timestamps if the local Whisper server is available; otherwise directed scene windows, labelled.", { storyboardId: "" }, undefined, { dependsOn: [6, 7] }),
      step("captions.render", "Compose captions", "Two-line maximum inside safe areas using measured glyph widths.", { storyboardId: "" }, undefined, { dependsOn: [8] }),
      step("media.render", "Render and validate the MP4", "FFmpeg H.264/AAC 1080x1920, motion, transitions, burned captions, atomic publish after ffprobe checks.", { storyboardId: "" }, undefined, { dependsOn: [9], resourceClass: "HEAVY" }),
      step("validation.ffprobe", "Independent verification", "Read the published file back from disk and verify every claim.", { path: "" }, undefined, { dependsOn: [10] }),
      step("artifact.register", "Register artifacts with the asset manifest", "Checksum every produced file and link it to this task.", { path: "", kind: "video" }, "asset_manager", { dependsOn: [11] }),
    ];
    notes.push("Heavy media stages are serialised by the scheduler; research fans out in parallel because it is network-bound and cheap.");
    return { intent: "VIDEO_PRODUCTION", title: `Produce a ${duration}s video about ${topic}`, steps, engine: input.llmEngine, engineDetail: input.llmDetail, notes, topic };
  }

  // ---------------- DOCUMENT ANALYSIS ------------------------------------------
  if (isDocument && (upload || /analyz|analys|summari|pdf|docx|xlsx|csv/.test(lower))) {
    const steps: PlannedStep[] = [
      step("doc.extract", "Extract the document", upload ? `Extract text from the uploaded ${upload.originalName}.` : "Locate and extract the referenced document.", upload ? { uploadId: upload.id } : { path: extractPathHint(message) }),
      step("doc.analyse", "Analyse the content", "Structure, key phrases, statistics, references and repetition profile.", { question: message.slice(0, 300) }, undefined, { dependsOn: [0] }),
      step("report.write", "Save the findings as a document", "Write a new Markdown report — the original upload is never modified.", { title: `Analysis — ${upload?.originalName ?? topic}`, sections: [] }, undefined, { dependsOn: [1] }),
      step("validation.ffprobe", "Validate the written report file", "Read the produced file back from disk (size, readability, checksum) before reporting success.", { path: "" }, "validation_agent", { dependsOn: [2] }),
    ];
    return { intent: "DOCUMENT_ANALYSIS", title: `Analyse ${upload?.originalName ?? topic}`, steps, engine: input.llmEngine, engineDetail: input.llmDetail, notes, topic };
  }

  // ---------------- SHELL COMMAND ----------------------------------------------
  if (isShell) {
    const command = extractCommand(message);
    if (!command) {
      notes.push("No explicit command text was found in the request, so the plan stops at validation and asks for the exact command.");
    }
    const steps: PlannedStep[] = [
      step("shell.preview", "Validate the command", "Run the command validator against the deny-list and allowlist before anything executes.", { command: command ?? "" }),
    ];
    if (command) {
      steps.push(step("shell.execute", "Execute with approval", "HIGH risk: runs only after you approve these exact parameters. Timeout 45s, fully audited, cancellable.", { command }, undefined, { dependsOn: [0] }));
    }
    notes.push("PowerShell/exact-command execution is never hidden: the approval dialog shows the full command text and its hash.");
    return { intent: "SHELL_COMMAND", title: command ? `Run command: ${command.slice(0, 60)}` : "Validate and run a shell command", steps, engine: input.llmEngine, engineDetail: input.llmDetail, notes, topic: command ?? topic };
  }

  // ---------------- DIAGNOSTICS -------------------------------------------------
  if (isDiagnostics) {
    const steps: PlannedStep[] = [
      step("doctor.run", "Run the Doctor", "Functional probes of every capability: binaries encode/read-back tests, model round-trip, shell probe, UIA probe, sidecar, browser launch, permissions, disk.", { deep: true }),
      step("host.inspect", "Inspect the host", "OS, CPU, memory, disk, workspace roots and process sample.", { detail: "processes" }, undefined, { parallel: true }),
      step("capabilities.probe", "Probe the capability registry", "Every capability must pass a functional probe before it can report AVAILABLE.", {}, undefined, { parallel: true }),
      step("artifact.register", "Write the diagnostics report", "Persist the report as a task artifact with a checksum.", { path: "", kind: "diagnostics" }, "asset_manager", { dependsOn: [0, 1, 2] }),
    ];
    return { intent: "DIAGNOSTICS", title: "System diagnostics", steps, engine: input.llmEngine, engineDetail: input.llmDetail, notes, topic: "system diagnostics" };
  }

  // ---------------- BROWSER AUTOMATION -----------------------------------------
  if (wantsBrowser && !wantsDesktop) {
    const url = extractUrl(message) ?? "https://en.wikipedia.org/wiki/Black_hole";
    const targetText = /find (?:the )?(?:element|text) "([^"]{2,60})"/i.exec(message)?.[1] ?? /\bfor "([^"]{2,60})"/i.exec(message)?.[1] ?? null;
    const steps: PlannedStep[] = [
      step("browser.probe", "Verify the browser engine is really working", "Launch the automation engine and read a page back. If it is not installed, say so instead of pretending.", {}),
      step("browser.navigate", "Navigate to the page", `Open ${url} in the automation engine and capture the rendered document.`, { url }, undefined, { dependsOn: [0] }),
      step("browser.extract", "Extract the page structure", "Visible text, headings, links, buttons and inputs from the rendered DOM.", { url }, "browser_agent", { dependsOn: [1] }),
      step("browser.screenshot", "Capture evidence", "PNG screenshot of the rendered page stored as a task artifact.", { url }, "vision_agent", { dependsOn: [1] }),
    ];
    if (targetText) {
      steps.push(step("browser.verify", "Verify the requested element", `Confirm the page really contains "${targetText}" and report its surrounding content.`, { url, expectedText: targetText }, "validation_agent", { dependsOn: [2] }));
    }
    if (wantsBrowserInteraction) {
      steps.push(
        step("browser.interact", "Interact with the page", "Semantic interaction through the DOM (click/type/scroll) — never blind coordinates when the DOM is available.", { url, action: "click", selector: "a" }, "browser_agent", { dependsOn: [2] }),
      );
    }
    notes.push("Browser automation is only used when the engine is installed and its launch probe succeeds; otherwise the HTTP research path is used and labelled.");
    return { intent: "BROWSER_AUTOMATION", title: `Browser task on ${url.replace(/^https?:\/\//, "").slice(0, 50)}`, steps, engine: input.llmEngine, engineDetail: input.llmDetail, notes, topic };
  }

  // ---------------- DESKTOP / COMPUTER USE -------------------------------------
  if (wantsDesktop) {
    const appMatch = /open (?:the )?(notepad|calculator|explorer|cmd|terminal|chrome|edge|word|excel|paint|[A-Za-z0-9 ._-]{2,30})/i.exec(message)?.[1]?.trim();
    const typeText = /type\s+["']([^"']{1,120})["']/i.exec(message)?.[1] ?? /type\s+(.{1,80})$/i.exec(message)?.[1]?.trim() ?? null;
    const hotkey = /(?:press|hotkey)\s+([A-Za-z0-9+\- ]{2,30})/i.exec(message)?.[1]?.trim() ?? null;
    const steps: PlannedStep[] = [
      step("computer.state", "Capture the current computer state", "Active window, visible windows, screenshot path, clipboard, pointer and focused control — the evidence baseline for verification.", { purpose: message.slice(0, 200) }, "vision_agent"),
    ];
    let index = 0;
    if (appMatch) {
      steps.push(step("windows.open", "Open the application", `Launch "${appMatch}" and verify a real window appears.`, { target: appMatch }, "computer_agent", { dependsOn: [index] }));
      index += 1;
      steps.push(step("windows.list", "Enumerate windows and the UI Automation tree", "Semantic discovery first: window titles, automation ids, control types, bounding rectangles.", { purpose: message.slice(0, 200) }, "vision_agent", { dependsOn: [index] }));
      index += 1;
    }
    if (typeText) {
      steps.push(step("windows.type", "Type the requested text", `Type "${typeText}" into the focused application using real keyboard input.`, { text: typeText }, "computer_agent", { dependsOn: [index] }));
      index += 1;
    }
    if (hotkey) {
      steps.push(step("windows.hotkey", "Send the hotkey", `Send the "${hotkey}" combination as real keyboard input.`, { keys: hotkey }, "computer_agent", { dependsOn: [Math.max(0, index - 1)] }));
      index += 1;
    }
    steps.push(step("windows.screenshot", "Capture the resulting screen", "Screenshot after the action, stored as a real artifact.", {}, "vision_agent", { dependsOn: [Math.max(0, index - 1)] }));
    steps.push(
      step(
        "computer.verify",
        "Verify the resulting state",
        "Re-inspect the window/control tree, typed text and file state. Success is claimed only when the evidence confirms it — never because an input command was sent.",
        { expectation: typeText ?? appMatch ?? message.slice(0, 200), app: appMatch ?? null, typedText: typeText ?? null, saveAs: /save (?:it )?to ([^\s"']+)/i.exec(message)?.[1] ?? null },
        "validation_agent",
        { dependsOn: [index] },
      ),
    );
    notes.push("Coordinate clicking is a last resort: UI Automation semantics first, then rendered/image evidence, then coordinates — the engine used is recorded per action.");
    return { intent: "DESKTOP_CONTROL", title: appMatch ? `Desktop control: ${appMatch}` : "Desktop control", steps, engine: input.llmEngine, engineDetail: input.llmDetail, notes, topic: appMatch ?? "desktop" };
  }

  // ---------------- EMAIL -------------------------------------------------------
  if (isEmailOnly) {
    const steps: PlannedStep[] = [
      step("email.list", "Read the inbox", "Only works when an IMAP/Gmail/Graph connector is configured; otherwise it reports NOT_CONFIGURED.", { query: "", limit: 10 }),
      step("artifact.register", "Record the mailbox summary", "Persist the real fetched message list as an artifact so it is auditable.", { path: "", kind: "email-summary" }, "asset_manager", { dependsOn: [0] }),
    ];
    return { intent: "EMAIL", title: "Inbox review", steps, engine: input.llmEngine, engineDetail: input.llmDetail, notes, topic: "inbox" };
  }

  // ---------------- FILE OPERATIONS --------------------------------------------
  if (isFile && !isResearch) {
    const target = extractPathHint(message);
    if (/delete/i.test(lower)) {
      const steps: PlannedStep[] = [
        step("fs.list", "Confirm the targets exist", `List ${target} so the deletion targets are explicit.`, { path: target }),
        step("fs.delete", "Delete with typed confirmation", "HIGH risk. Requires the confirmation phrase DELETE in addition to approval.", { paths: [target], confirmation: "DELETE", reason: message.slice(0, 200) }, undefined, { dependsOn: [0] }),
      ];
      return { intent: "FILE_OPERATION", title: `Delete under ${target}`, steps, engine: input.llmEngine, engineDetail: input.llmDetail, notes: ["Deletion is irreversible and always shows the exact paths before running."], topic: target };
    }
    if (/create|write/i.test(lower) && /file/i.test(lower)) {
      const content = extractCommand(message) ?? "";
      const steps: PlannedStep[] = [
        step("fs.write", "Create a new file", "Creates a NEW file with a unique name — nothing existing is overwritten.", { path: target.endsWith(".txt") || target.endsWith(".md") ? target : `${target}/note_${Date.now()}.md`, content }),
        step("fs.read", "Read the file back", "Verification: the file must actually exist on disk with the expected content.", { path: target.endsWith(".txt") || target.endsWith(".md") ? target : "documents" }, "validation_agent", { dependsOn: [0] }),
      ];
      return { intent: "FILE_OPERATION", title: `Create ${target}`, steps, engine: input.llmEngine, engineDetail: input.llmDetail, notes, topic: target };
    }
    const steps: PlannedStep[] = [step("fs.list", "Inspect the location", `Real directory listing for ${target}.`, { path: target, limit: 100 })];
    if (/read|open|analyse|analyz/i.test(lower)) {
      steps.push(
        step("fs.read", "Read the file", `Read ${target} inside the permitted scope.`, { path: target }, undefined, { dependsOn: [0] }),
        step("report.write", "Summarise what was found", "Write a short Markdown summary of the real directory/contents.", { title: `Filesystem report — ${target}`, sections: [] }, undefined, { dependsOn: [1] }),
        step("validation.ffprobe", "Verify the written report", "Read the produced file back from disk before claiming success.", { path: "" }, "validation_agent", { dependsOn: [2] }),
      );
    }
    return { intent: "FILE_OPERATION", title: `Files at ${target}`, steps, engine: input.llmEngine, engineDetail: input.llmDetail, notes, topic: target };
  }

  // ---------------- RESEARCH + REPORT (+ optional email) -----------------------
  if (isResearch || wantsEmail(message)) {
    const steps: PlannedStep[] = [
      step("research.search", "Research live sources", `Query Wikipedia, OpenAlex and Hacker News for "${topic}" and keep real URLs.`, { query: topic, limit: 10 }, undefined, { parallel: true }),
      step("research.search", "Research an independent second query", `Second live query ("${topic} evidence comparison") executed concurrently so both source sets can be cross-checked.`, { query: `${topic} evidence comparison`, limit: 8 }, undefined, { parallel: true }),
      step("research.verify", "Cross-check the evidence", "Flag anything the sources do not support so it never enters the report unlabelled.", { claims: [], sources: [] }, undefined, { dependsOn: [0, 1] }),
    ];
    if (wantsReportFile(message) || /report|compare|summar/i.test(lower)) {
      const wantsPdf = /(pdf|docx|word document)/i.test(lower);
      const destination = /documents/i.test(lower) ? "documents" : undefined;
      steps.push(
        step("report.write", "Write the report", `Compose a Markdown report${destination ? " in your Documents folder" : ""}. MEDIUM risk: creating a file on disk is always approved.`, { title: `Research — ${topic}`, sections: [], destination }, undefined, { dependsOn: [2] }),
      );
      if (wantsPdf) {
        steps.push(
          step("report.export", "Export a PDF/DOCX copy", "Convert the written report into a PDF or DOCX artifact in addition to Markdown.", { artifactPath: "", format: wantsPdf && /docx|word/i.test(lower) ? "docx" : "pdf" }, "document_agent", { dependsOn: [3] }),
          step("artifact.register", "Register and checksum the exports", "Link every produced file to this task with a checksum.", { path: "", kind: "report" }, "asset_manager", { dependsOn: [4] }),
        );
      }
    }
    if (wantsEmail(message)) {
      const lastIndex = steps.length - 1;
      steps.push(
        step("email.draft", "Prepare the email", "Creates a real .eml draft artifact for review — nothing is transmitted.", { to: "me", subject: `Research: ${topic}`, body: "" }, "email_agent", { dependsOn: [lastIndex] }),
        step("email.send", "Send the email", "HIGH risk: external communication. Only runs when SMTP is configured and you approve these exact parameters.", { to: "me", subject: `Research: ${topic}`, body: "" }, "email_agent", { dependsOn: [lastIndex + 1] }),
      );
      notes.push("Email sending stays disabled unless SMTP_URL is configured; the draft is still produced so nothing is lost.");
    }
    return { intent: "RESEARCH_REPORT", title: `Research ${topic}`, steps, engine: input.llmEngine, engineDetail: input.llmDetail, notes, topic };
  }

  // ---------------- GENERAL ----------------------------------------------------
  const steps: PlannedStep[] = [
    step("supervisor.answer", "Answer from what we actually know", "No side effects. Uses the configured local model when available, otherwise the deterministic engine that refuses to invent facts.", { question: message.slice(0, 900) }),
    step("host.inspect", "Attach current system context", "Grounds the answer in real host and workspace state.", { detail: "summary" }, undefined, { parallel: true }),
  ];
  return { intent: "GENERAL", title: message.slice(0, 70) || "General request", steps, engine: input.llmEngine, engineDetail: input.llmDetail, notes, topic };
}

export function themesForUi() {
  return THEMES.map((theme) => ({ id: theme.id, name: theme.name, accent: theme.accent }));
}
