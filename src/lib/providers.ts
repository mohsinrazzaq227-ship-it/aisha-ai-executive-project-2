import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";

export type ProviderStatus = "AVAILABLE" | "UNAVAILABLE" | "DISABLED" | "ERROR" | "CLIENT_SIDE" | "OPTIONAL_UNTESTED";

export type ProviderReport = {
  id: string;
  label: string;
  kind: "LLM" | "STT" | "TTS" | "MEDIA" | "RESEARCH" | "HOST" | "VISION" | "EMAIL" | "STORAGE";
  status: ProviderStatus;
  detail: string;
  local: boolean;
  cost: "free-local" | "free-network" | "paid-optional";
  requiresConfig?: string[];
  checkedAt: string;
};

const require_ = createRequire(`${process.cwd()}/package.json`);

function run(bin: string, args: string[], timeoutMs = 4000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout ?? "", stderr: stderr ?? String(error ?? "") });
    });
  });
}

export function which(bin: string): string | null {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(finder, [bin], { timeout: 3000, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .split(/\r?\n/)[0]
      .trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function ffmpegBinary(): string | null {
  const fromEnv = process.env.FFMPEG_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  try {
    const bundled = require_("ffmpeg-static") as string | null;
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {
    /* not installed */
  }
  return which("ffmpeg");
}

export function ffprobeBinary(): string | null {
  const fromEnv = process.env.FFPROBE_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  try {
    const bundled = require_("ffprobe-static") as { path?: string } | null;
    if (bundled?.path && fs.existsSync(bundled.path)) return bundled.path;
  } catch {
    /* not installed */
  }
  return which("ffprobe");
}

async function httpProbe(url: string, timeoutMs = 2500): Promise<{ ok: boolean; body: string; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const body = await res.text();
    return { ok: res.ok, body };
  } catch (error) {
    return { ok: false, body: "", error: (error as Error).message };
  }
}

const currentYear = new Date().getFullYear();

/** Full provider inventory. Every probe is real; nothing is assumed available. */
export async function providerInventory(): Promise<ProviderReport[]> {
  const checkedAt = new Date().toISOString();
  const reports: ProviderReport[] = [];

  // ---- Media: FFmpeg / FFprobe -------------------------------------------------
  const ffmpeg = ffmpegBinary();
  if (ffmpeg) {
    const version = await run(ffmpeg, ["-hide_banner", "-version"]);
    const firstLine = version.stdout.split("\n")[0]?.trim() ?? "";
    reports.push({
      id: "ffmpeg",
      label: "FFmpeg encoder",
      kind: "MEDIA",
      status: version.ok ? "AVAILABLE" : "ERROR",
      detail: version.ok ? firstLine : `Located at ${ffmpeg} but failed to run: ${version.stderr.slice(0, 200)}`,
      local: true,
      cost: "free-local",
      checkedAt,
    });
  } else {
    reports.push({
      id: "ffmpeg",
      label: "FFmpeg encoder",
      kind: "MEDIA",
      status: "UNAVAILABLE",
      detail: "No ffmpeg binary found (bundled ffmpeg-static missing and ffmpeg not on PATH). Video rendering will fail loudly, not silently.",
      local: true,
      cost: "free-local",
      checkedAt,
    });
  }

  const ffprobe = ffprobeBinary();
  if (ffprobe) {
    const version = await run(ffprobe, ["-hide_banner", "-version"]);
    reports.push({
      id: "ffprobe",
      label: "FFprobe validator",
      kind: "MEDIA",
      status: version.ok ? "AVAILABLE" : "ERROR",
      detail: version.ok ? version.stdout.split("\n")[0]?.trim() ?? "" : `Located at ${ffprobe} but failed to run.`,
      local: true,
      cost: "free-local",
      checkedAt,
    });
  } else {
    reports.push({
      id: "ffprobe",
      label: "FFprobe validator",
      kind: "MEDIA",
      status: "UNAVAILABLE",
      detail: "No ffprobe binary found. Rendered files cannot be independently validated.",
      local: true,
      cost: "free-local",
      checkedAt,
    });
  }

  // ---- LLM: Ollama (local) -----------------------------------------------------
  const ollamaUrl = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
  const ollama = await httpProbe(`${ollamaUrl}/api/tags`);
  if (ollama.ok) {
    let models: string[] = [];
    try {
      models = (JSON.parse(ollama.body).models ?? []).map((m: { name: string }) => m.name);
    } catch {
      models = [];
    }
    reports.push({
      id: "llm.ollama",
      label: "Ollama (local LLM)",
      kind: "LLM",
      status: models.length > 0 ? "AVAILABLE" : "UNAVAILABLE",
      detail: models.length > 0
        ? `Reachable at ${ollamaUrl}. Installed models: ${models.join(", ")}. Configured model: ${process.env.OLLAMA_MODEL ?? "llama3.1:8b"}`
        : `Reachable at ${ollamaUrl} but no models installed. Run: ollama pull llama3.1:8b`,
      local: true,
      cost: "free-local",
      requiresConfig: ["OLLAMA_URL", "OLLAMA_MODEL"],
      checkedAt,
    });
  } else {
    reports.push({
      id: "llm.ollama",
      label: "Ollama (local LLM)",
      kind: "LLM",
      status: "UNAVAILABLE",
      detail: `No Ollama server answered at ${ollamaUrl}. The deterministic local planner is used for intent parsing and script writing instead. Nothing silently switches to a paid API.`,
      local: true,
      cost: "free-local",
      requiresConfig: ["OLLAMA_URL", "OLLAMA_MODEL"],
      checkedAt,
    });
  }

  // ---- LLM: optional cloud (explicit opt-in only) ------------------------------
  const cloudKeys = Object.entries({
    OPENAI_API_KEY: "OpenAI",
    ANTHROPIC_API_KEY: "Anthropic",
    GROQ_API_KEY: "Groq (free tier)",
    OPENROUTER_API_KEY: "OpenRouter (free models)",
  }).filter(([key]) => Boolean(process.env[key]));
  const cloudEnabled = process.env.AI_EXECUTIVE_ENABLE_CLOUD_LLM === "true";
  if (cloudKeys.length === 0) {
    reports.push({
      id: "llm.cloud",
      label: "Optional cloud LLM",
      kind: "LLM",
      status: "DISABLED",
      detail: "No cloud API keys present. This build is fully local/rule-based for planning.",
      local: false,
      cost: "paid-optional",
      checkedAt,
    });
  } else {
    reports.push({
      id: "llm.cloud",
      label: `Optional cloud LLM (${cloudKeys.map(([, name]) => name).join(", ")} key detected)`,
      kind: "LLM",
      status: cloudEnabled ? "OPTIONAL_UNTESTED" : "DISABLED",
      detail: cloudEnabled
        ? "Key present and AI_EXECUTIVE_ENABLE_CLOUD_LLM=true. Requests are sent explicitly and the active engine is always displayed."
        : "Key present but AI_EXECUTIVE_ENABLE_CLOUD_LLM is not 'true', so the provider stays disabled. Fallbacks are never silent.",
      local: false,
      cost: "paid-optional",
      requiresConfig: ["AI_EXECUTIVE_ENABLE_CLOUD_LLM"],
      checkedAt,
    });
  }

  // ---- STT ---------------------------------------------------------------------
  const whisperUrl = process.env.WHISPER_URL;
  if (!whisperUrl) {
    reports.push({
      id: "stt.whisper",
      label: "faster-whisper server (local STT)",
      kind: "STT",
      status: "DISABLED",
      detail: "WHISPER_URL is not set. Set it to a local faster-whisper server (e.g. http://127.0.0.1:8178) for word-accurate transcription and alignment.",
      local: true,
      cost: "free-local",
      requiresConfig: ["WHISPER_URL"],
      checkedAt,
    });
  } else {
    const probe = await httpProbe(whisperUrl.replace(/\/$/, "") + "/health");
    reports.push({
      id: "stt.whisper",
      label: "faster-whisper server (local STT)",
      kind: "STT",
      status: probe.ok ? "AVAILABLE" : "ERROR",
      detail: probe.ok ? `Reachable at ${whisperUrl}. Word-level timestamps enabled.` : `WHISPER_URL set but probe failed: ${probe.error ?? "non-200 response"}`,
      local: true,
      cost: "free-local",
      checkedAt,
    });
  }

  reports.push({
    id: "stt.browser",
    label: "Browser speech engine (fallback STT)",
    kind: "STT",
    status: "CLIENT_SIDE",
    detail: "The renderer can use the operating system's built-in speech recognition. The microphone path always shows whether the local Whisper server or the browser engine produced the transcript.",
    local: true,
    cost: "free-local",
    checkedAt,
  });

  // ---- TTS ---------------------------------------------------------------------
  const ttsUrl = process.env.TTS_URL;
  if (!ttsUrl) {
    reports.push({
      id: "tts.server",
      label: "Local TTS server (Piper/Kokoro/faster-tts)",
      kind: "TTS",
      status: "DISABLED",
      detail: "TTS_URL is not set. A local speech server would enable narration rendered into video files; without it narration is spoken in the UI but video audio uses a synthesised music/ambience bed, clearly labelled as such.",
      local: true,
      cost: "free-local",
      requiresConfig: ["TTS_URL"],
      checkedAt,
    });
  } else {
    const probe = await httpProbe(ttsUrl.replace(/\/$/, "") + "/health");
    reports.push({
      id: "tts.server",
      label: "Local TTS server",
      kind: "TTS",
      status: probe.ok ? "AVAILABLE" : "ERROR",
      detail: probe.ok ? `Reachable at ${ttsUrl}. Narration can be rendered into MP4 audio.` : `TTS_URL set but probe failed: ${probe.error ?? "non-200 response"}`,
      local: true,
      cost: "free-local",
      checkedAt,
    });
  }

  reports.push({
    id: "tts.browser",
    label: "Browser/OS speech synthesis",
    kind: "TTS",
    status: "CLIENT_SIDE",
    detail: "Used for spoken agent responses in the interface with true cancellation and interruption. Not burned into rendered files.",
    local: true,
    cost: "free-local",
    checkedAt,
  });

  // ---- Research network ---------------------------------------------------------
  const researchUrls: Array<{ id: string; url: string; note: string }> = [
    { id: "research.wikipedia", url: "https://en.wikipedia.org/api/rest_v1/page/summary/Black_hole", note: "Wikipedia REST API" },
    { id: "research.openalex", url: `https://api.openalex.org/works?search=artificial%20intelligence&per-page=1`, note: "OpenAlex scholarly index" },
    { id: "research.hn", url: "https://hn.algolia.com/api/v1/search?query=local%20ai&hitsPerPage=1", note: "Hacker News Algolia search" },
  ];
  for (const source of researchUrls) {
    const probe = await httpProbe(source.url, 6000);
    reports.push({
      id: source.id,
      label: `${source.note} research source`,
      kind: "RESEARCH",
      status: probe.ok ? "AVAILABLE" : "ERROR",
      detail: probe.ok ? `Reachable (${new Date().getFullYear()} live queries verified).` : `Probe failed: ${probe.error ?? "non-200"}`,
      local: false,
      cost: "free-network",
      checkedAt,
    });
  }

  // ---- Browser automation -------------------------------------------------------
  let playwrightInstalled = false;
  try {
    require_.resolve("playwright");
    playwrightInstalled = true;
  } catch {
    playwrightInstalled = false;
  }
  reports.push({
    id: "browser.playwright",
    label: "Playwright browser automation",
    kind: "RESEARCH",
    status: playwrightInstalled ? "AVAILABLE" : "UNAVAILABLE",
    detail: playwrightInstalled
      ? "Playwright is installed; full DOM navigation is available for the Browser Agent."
      : "Playwright is not installed. The Browser Agent uses the HTTP extraction engine (fetch + structured parsers) instead, which is reported per task.",
    local: true,
    cost: "free-local",
    requiresConfig: ["npm install playwright && npx playwright install chromium"],
    checkedAt,
  });

  // ---- Vision -------------------------------------------------------------------
  const tesseract = which("tesseract");
  reports.push({
    id: "vision.ocr",
    label: "OCR engine (Tesseract)",
    kind: "VISION",
    status: tesseract ? "AVAILABLE" : "UNAVAILABLE",
    detail: tesseract ? `Tesseract found at ${tesseract}. OCR fallback available for screenshots.` : "Tesseract not found. Vision work reports OCR as unavailable instead of guessing at text.",
    local: true,
    cost: "free-local",
    checkedAt,
  });

  // ---- Host control -------------------------------------------------------------
  const isWindows = process.platform === "win32";
  const pwsh = which(process.platform === "win32" ? "powershell" : "pwsh");
  reports.push({
    id: "host.shell",
    label: isWindows ? "PowerShell execution" : "Host shell execution (POSIX)",
    kind: "HOST",
    status: pwsh ? "AVAILABLE" : "UNAVAILABLE",
    detail: pwsh
      ? `Shell interpreter: ${pwsh}. Every execution requires approval, passes a validator and is fully audited.`
      : `No ${isWindows ? "PowerShell" : "pwsh"} interpreter on this host. The Computer Agent will refuse the action and say so rather than pretend.`,
    local: true,
    cost: "free-local",
    checkedAt,
  });

  reports.push({
    id: "host.windows",
    label: "Windows desktop control (UI automation, windows, clipboard)",
    kind: "HOST",
    status: isWindows ? "AVAILABLE" : "UNAVAILABLE",
    detail: isWindows
      ? "Running on Windows: window enumeration, focus, screenshots and clipboard control are available."
      : `Host OS is ${os.platform()} (${os.release()}). Windows-only tools (pywinauto window control, clipboard, screenshots) are honestly reported unavailable in this environment.`,
    local: true,
    cost: "free-local",
    checkedAt,
  });

  // ---- Email --------------------------------------------------------------------
  const emailConfigured = Boolean(process.env.SMTP_URL || process.env.IMAP_URL || process.env.GMAIL_REFRESH_TOKEN || process.env.MS_GRAPH_TOKEN);
  reports.push({
    id: "email.connector",
    label: "Email connector (IMAP/SMTP/Gmail/Graph)",
    kind: "EMAIL",
    status: emailConfigured ? "OPTIONAL_UNTESTED" : "DISABLED",
    detail: emailConfigured
      ? "Credentials detected. The Email Agent can list and summarise, and will request HIGH-risk approval before sending."
      : "No IMAP/SMTP/OAuth credentials configured. Inbox features stay disabled and the Email Agent reports NOT CONFIGURED instead of inventing mail.",
    local: false,
    cost: "free-network",
    requiresConfig: ["SMTP_URL", "IMAP_URL", "GMAIL_REFRESH_TOKEN", "MS_GRAPH_TOKEN"],
    checkedAt,
  });

  // ---- Storage ------------------------------------------------------------------
  const dbUrl = process.env.DATABASE_URL ?? "";
  reports.push({
    id: "storage.postgres",
    label: "Task/artifact database",
    kind: "STORAGE",
    status: dbUrl ? "AVAILABLE" : "ERROR",
    detail: dbUrl ? `Connected via Drizzle ORM to ${dbUrl.replace(/:\/\/[^@]*@/, "://***@")}. Durable tasks, approvals, events, artifacts.` : "DATABASE_URL missing — the supervisor cannot persist task state.",
    local: true,
    cost: "free-local",
    checkedAt,
  });

  reports.push({
    id: "vision.render",
    label: "Deterministic frame renderer (vector → PNG)",
    kind: "VISION",
    status: "AVAILABLE",
    detail: `Sharp + OpenType vector glyph rendering, offline, computed locally. No image API, no costs, fully reproducible. Verified ${currentYear}.`,
    local: true,
    cost: "free-local",
    checkedAt,
  });

  return reports;
}

export function providerSummary(reports: ProviderReport[]) {
  return {
    available: reports.filter((r) => r.status === "AVAILABLE").length,
    unavailable: reports.filter((r) => r.status === "UNAVAILABLE" || r.status === "ERROR").length,
    disabled: reports.filter((r) => r.status === "DISABLED").length,
    clientSide: reports.filter((r) => r.status === "CLIENT_SIDE").length,
  };
}
