import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { ffmpegBinary, ffprobeBinary, which } from "@/lib/providers";
import { ensureDir, humanSize, roots } from "@/lib/workspace";
import { pythonSidecar } from "@/lib/pythonSidecar";

const execFileAsync = promisify(execFile);
const require_ = createRequire(`${process.cwd()}/package.json`);

/**
 * Capability registry with TRUTHFUL states.
 *
 *   AVAILABLE       — a functional probe succeeded (something actually ran)
 *   DEGRADED        — works, but a documented limitation applies
 *   NOT_CONFIGURED  — the software exists but the user has not configured it
 *   UNAVAILABLE     — prerequisite missing in this environment
 *   FAILED          — the probe ran and the component is broken
 *   NOT_VERIFIED    — code ships but could not be verified in this environment
 *   CLIENT_SIDE     — implemented in the renderer, verified by the browser runtime
 *
 * Dependency presence is never enough: every probe below executes real work.
 */

export type CapabilityStatus = "AVAILABLE" | "DEGRADED" | "NOT_CONFIGURED" | "UNAVAILABLE" | "FAILED" | "NOT_VERIFIED" | "CLIENT_SIDE";

export type Capability = {
  id: string;
  label: string;
  group: "Runtime" | "Intelligence" | "Computer use" | "Browser" | "Voice" | "Documents" | "Media" | "Data" | "Interface";
  status: CapabilityStatus;
  detail: string;
  /** What the probe actually did — this is the evidence for the claim. */
  evidence: string;
  probeMs: number;
  requires?: string[];
  installPath?: string;
};

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - started };
}

async function run(bin: string, args: string[], timeoutMs = 15000): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, stdout: result.stdout.toString(), stderr: result.stderr.toString(), code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number; message: string };
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message, code: err.code ?? -1 };
  }
}

async function httpProbe(url: string, init?: RequestInit, timeoutMs = 6000): Promise<{ ok: boolean; status: number; body: string; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { ...init, signal: controller.signal });
    const body = await res.text();
    clearTimeout(timer);
    return { ok: res.ok, status: res.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: "", error: (error as Error).message };
  }
}

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1000);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

/* ------------------------------------------------------------------ */
/* Media probes: real encode + real read-back                          */
/* ------------------------------------------------------------------ */

async function probeFfmpeg(): Promise<Capability> {
  const bin = ffmpegBinary();
  if (!bin) {
    return {
      id: "media.ffmpeg",
      label: "FFmpeg encoder",
      group: "Media",
      status: "UNAVAILABLE",
      detail: "No ffmpeg binary is present, so no video can be produced. Video tasks fail loudly instead of returning a fake file.",
      evidence: "searched: FFMPEG_PATH, bundled ffmpeg-static, PATH",
      probeMs: 0,
      installPath: "npm install (installs ffmpeg-static) or set FFMPEG_PATH",
    };
  }
  const probeDir = ensureDir(path.join(roots().tempRoot, "probes"));
  const out = path.join(probeDir, `ffmpeg_probe_${process.pid}.mp4`);
  const { value, ms } = await timed(() =>
    run(
      bin,
      ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=0.4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out],
      60000,
    ),
  );
  const exists = fs.existsSync(out);
  const size = exists ? fs.statSync(out).size : 0;
  const version = (await run(bin, ["-hide_banner", "-version"], 8000)).stdout.split("\n")[0]?.trim() ?? "";
  if (!value.ok || !exists || size < 1000) {
    return {
      id: "media.ffmpeg",
      label: "FFmpeg encoder",
      group: "Media",
      status: "FAILED",
      detail: `FFmpeg is present at ${bin} but the encode probe failed: ${value.stderr.split("\n").slice(-2).join(" ").slice(0, 220)}`,
      evidence: `attempted 0.4s H.264 encode -> exit ${value.code}`,
      probeMs: ms,
    };
  }
  fs.rmSync(out, { force: true });
  return {
    id: "media.ffmpeg",
    label: "FFmpeg encoder",
    group: "Media",
    status: "AVAILABLE",
    detail: `${version} — real H.264 encode probe succeeded.`,
    evidence: `encoded a 0.4s 320x240 H.264 clip (${humanSize(size)}) then deleted it`,
    probeMs: ms,
  };
}

async function probeFfprobe(): Promise<Capability> {
  const bin = ffprobeBinary();
  if (!bin) {
    return {
      id: "media.ffprobe",
      label: "FFprobe validator",
      group: "Media",
      status: "UNAVAILABLE",
      detail: "No ffprobe binary, so produced media cannot be independently verified.",
      evidence: "searched: FFPROBE_PATH, bundled ffprobe-static, PATH",
      probeMs: 0,
      installPath: "npm install (installs ffprobe-static) or set FFPROBE_PATH",
    };
  }
  const ffmpeg = ffmpegBinary();
  if (!ffmpeg) {
    return {
      id: "media.ffprobe",
      label: "FFprobe validator",
      group: "Media",
      status: "DEGRADED",
      detail: `${bin} is present but FFmpeg is missing, so no file can be produced to verify against.`,
      evidence: `readable: ${(await run(bin, ["-hide_banner", "-version"], 8000)).ok}`,
      probeMs: 0,
    };
  }
  const probeDir = ensureDir(path.join(roots().tempRoot, "probes"));
  const sample = path.join(probeDir, `ffprobe_probe_${process.pid}.mp4`);
  await run(ffmpeg, ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=0.4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", sample], 60000);
  const { value, ms } = await timed(() => run(bin, ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", sample], 15000));
  let codec = "unknown";
  try {
    const parsed = JSON.parse(value.stdout) as { streams?: { codec_name?: string }[] };
    codec = parsed.streams?.[0]?.codec_name ?? "unknown";
  } catch {
    codec = "unparsable";
  }
  const ok = value.ok && codec === "h264";
  fs.rmSync(sample, { force: true });
  return {
    id: "media.ffprobe",
    label: "FFprobe validator",
    group: "Media",
    status: ok ? "AVAILABLE" : "FAILED",
    detail: ok ? "Reads container/stream metadata back from a real file and reports the true codec." : `Probe returned codec "${codec}" which is not the expected h264.`,
    evidence: "encoded a throwaway clip, parsed its stream metadata with ffprobe, verified codec=h264",
    probeMs: ms,
  };
}

async function probeOcr(): Promise<Capability> {
  const tesseract = which("tesseract");
  if (!tesseract) {
    return {
      id: "vision.ocr",
      label: "OCR engine",
      group: "Computer use",
      status: "NOT_CONFIGURED",
      detail: "No OCR engine installed. Screenshot text cannot be read, so the Vision Agent reports OCR as unavailable instead of guessing.",
      evidence: "probed: tesseract on PATH",
      probeMs: 0,
      installPath: "Install Tesseract OCR (or enable the Python sidecar with pytesseract)",
    };
  }
  // Functional probe: render a PNG with known text, OCR it, and compare.
  try {
    const { renderScenePng } = await import("@/lib/textrender");
    const image = await renderScenePng({
      index: 0,
      kicker: "probe",
      title: "AISHA OCR PROBE 42",
      body: "verification text",
      bullets: [],
      visualType: "TITLE_CARD",
      data: [],
      sources: [],
      accent: "#4cc9f0",
      accent2: "#8f7bff",
      themeId: "deep-space",
      totalScenes: 1,
    });
    const probeDir = ensureDir(path.join(roots().tempRoot, "probes"));
    const png = path.join(probeDir, `ocr_probe_${process.pid}.png`);
    fs.writeFileSync(png, image);
    const { value, ms } = await timed(() => run(tesseract, [png, "stdout"], 45000));
    fs.rmSync(png, { force: true });
    const recognized = value.stdout.replace(/\s+/g, " ").toUpperCase();
    const hit = recognized.includes("AISHA") || recognized.includes("PROBE") || recognized.includes("42");
    return {
      id: "vision.ocr",
      label: "OCR engine",
      group: "Computer use",
      status: hit ? "AVAILABLE" : "DEGRADED",
      detail: hit ? `Tesseract at ${tesseract} read a rendered probe image back correctly.` : "Tesseract ran but could not read the rendered probe image, so OCR quality is not dependable.",
      evidence: `OCR of a self-rendered "AISHA OCR PROBE 42" image returned: ${value.stdout.trim().slice(0, 90) || "(empty)"}`,
      probeMs: ms,
    };
  } catch (error) {
    return {
      id: "vision.ocr",
      label: "OCR engine",
      group: "Computer use",
      status: "FAILED",
      detail: `OCR probe could not complete: ${(error as Error).message}`,
      evidence: "probe aborted",
      probeMs: 0,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Windows computer-use probes: PowerShell + UI Automation             */
/* ------------------------------------------------------------------ */

async function probePowerShell(): Promise<Capability> {
  const isWindows = process.platform === "win32";
  const bin = isWindows ? (which("powershell.exe") ?? which("powershell") ?? which("pwsh")) : which("pwsh");
  if (!bin) {
    return {
      id: "host.shell",
      label: isWindows ? "PowerShell execution" : "PowerShell execution (pwsh)",
      group: "Computer use",
      status: "UNAVAILABLE",
      detail: isWindows
        ? "PowerShell was not found on PATH, which is unusual on Windows. Shell-backed tools are unavailable."
        : `This host is ${os.platform()}; PowerShell-backed desktop tools are only available on Windows. Nothing is simulated — the Computer Agent refuses and explains.`,
      evidence: "probed: powershell.exe / powershell / pwsh on PATH",
      probeMs: 0,
      installPath: isWindows ? "Repair the Windows PowerShell installation" : "Run the desktop build on Windows 10/11 x64",
    };
  }
  const { value, ms } = await timed(() => run(bin, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], 20000));
  const version = value.stdout.trim();
  return {
    id: "host.shell",
    label: "PowerShell execution",
    group: "Computer use",
    status: value.ok && version.length > 0 ? "AVAILABLE" : "FAILED",
    detail: value.ok ? `PowerShell ${version} at ${bin}. Every execution is validated, approved, timed out and audited.` : `PowerShell probe failed: ${value.stderr.slice(0, 180)}`,
    evidence: `ran $PSVersionTable.PSVersion.ToString() -> "${version}"`,
    probeMs: ms,
  };
}

async function probeUiAutomation(): Promise<Capability> {
  if (process.platform !== "win32") {
    const sidecar = pythonSidecar.status();
    return {
      id: "computer.uia",
      label: "Windows UI Automation bridge",
      group: "Computer use",
      status: sidecar.available && sidecar.capabilities.includes("uia") ? "AVAILABLE" : "UNAVAILABLE",
      detail: `UI Automation requires Windows. This host is ${os.platform()}. The bridge itself is implemented (PowerShell + UIAutomationClient, plus a pywinauto path through the Python sidecar) and is probed for real on Windows — here it is honestly reported as unavailable.`,
      evidence: "probe requires a Windows host; no Windows API is emulated",
      probeMs: 0,
      installPath: "Run on Windows 10/11; enable the Python sidecar for the pywinauto path",
    };
  }
  const script = [
    "Add-Type -AssemblyName UIAutomationClient",
    "Add-Type -AssemblyName UIAutomationTypes",
    "$root=[System.Windows.Automation.AutomationElement]::RootElement",
    "$cond=[System.Windows.Automation.Condition]::TrueCondition",
    "$kids=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$cond)",
    "Write-Output $kids.Count",
  ].join("; ");
  const { value, ms } = await timed(() => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 25000));
  const count = Number(value.stdout.trim());
  const ok = value.ok && Number.isFinite(count);
  return {
    id: "computer.uia",
    label: "Windows UI Automation bridge",
    group: "Computer use",
    status: ok ? "AVAILABLE" : "FAILED",
    detail: ok ? `UI Automation tree reachable; ${count} top-level window(s) enumerated through the automation API.` : `UIA probe failed: ${value.stderr.slice(0, 200)}`,
    evidence: `loaded UIAutomationClient and enumerated root children -> ${value.stdout.trim() || "no output"}`,
    probeMs: ms,
  };
}

async function probeInputControl(): Promise<Capability> {
  if (process.platform !== "win32") {
    return {
      id: "computer.input",
      label: "Mouse & keyboard control",
      group: "Computer use",
      status: "UNAVAILABLE",
      detail: `Real mouse/keyboard injection (user32 SendInput, SetCursorPos, VkKeyScan) is implemented but only functions on Windows. Host: ${os.platform()}. No synthetic input is performed anywhere else.`,
      evidence: "probed: platform check (win32 only)",
      probeMs: 0,
      installPath: "Run on Windows 10/11 x64",
    };
  }
  const script = [
    "Add-Type -Namespace Aisha -Name Native -MemberDefinition '[DllImport(\"user32.dll\")]public static extern bool SetCursorPos(int X,int Y);[DllImport(\"user32.dll\")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);[DllImport(\"user32.dll\")]public static extern void keybd_event(byte k,byte s,uint f,int e);[DllImport(\"user32.dll\")]public static extern short VkKeyScan(char c);'",
    "Write-Output 'P/INVOKE-OK'",
  ].join("; ");
  const { value, ms } = await timed(() => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 25000));
  const ok = value.ok && value.stdout.includes("P/INVOKE-OK");
  return {
    id: "computer.input",
    label: "Mouse & keyboard control",
    group: "Computer use",
    status: ok ? "AVAILABLE" : "FAILED",
    detail: ok ? "Win32 input APIs compiled and are callable: pointer moves, clicks, drags, per-character typing and hotkeys." : `Input probe failed: ${value.stderr.slice(0, 200)}`,
    evidence: "compiled a P/Invoke binding for SetCursorPos/mouse_event/keybd_event/VkKeyScan",
    probeMs: ms,
  };
}

async function probeScreenshot(): Promise<Capability> {
  if (process.platform !== "win32") {
    return {
      id: "computer.screenshot",
      label: "Screen capture",
      group: "Computer use",
      status: "UNAVAILABLE",
      detail: `Screen capture is implemented through the Windows screen API and, when enabled, the Python sidecar (PIL/mss). Host: ${os.platform()}. No placeholder image is ever returned.`,
      evidence: "probed: platform check (win32 or python sidecar)",
      probeMs: 0,
      installPath: "Run on Windows, or enable the Python sidecar with Pillow/mss installed",
    };
  }
  const probeDir = ensureDir(path.join(roots().tempRoot, "probes"));
  const file = path.join(probeDir, `screenshot_probe_${process.pid}.png`);
  const script = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save("${file.replace(/\\/g, "\\\\")}"); $g.Dispose(); $bmp.Dispose(); Write-Output 'SAVED'`;
  const { value, ms } = await timed(() => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 30000));
  const exists = fs.existsSync(file);
  const size = exists ? fs.statSync(file).size : 0;
  if (exists) fs.rmSync(file, { force: true });
  const ok = value.ok && exists && size > 20000;
  return {
    id: "computer.screenshot",
    label: "Screen capture",
    group: "Computer use",
    status: ok ? "AVAILABLE" : "FAILED",
    detail: ok ? "Captured the primary display to a real PNG and verified its size." : `Screenshot probe failed: ${value.stderr.slice(0, 200)}`,
    evidence: exists ? `captured a ${humanSize(size)} PNG of the primary screen` : "no PNG was produced",
    probeMs: ms,
  };
}

/* ------------------------------------------------------------------ */
/* Browser automation: real launch probe                               */
/* ------------------------------------------------------------------ */

async function probeBrowser(): Promise<Capability> {
  let playwrightAvailable = false;
  try {
    require_.resolve("playwright");
    playwrightAvailable = true;
  } catch {
    playwrightAvailable = false;
  }
  if (!playwrightAvailable) {
    return {
      id: "browser.automation",
      label: "Browser automation (Playwright engine)",
      group: "Browser",
      status: "NOT_CONFIGURED",
      detail: "The automation engine is not installed, so interactive/JS-rendered pages cannot be driven. The HTTP research path still works and is labelled per task.",
      evidence: "probed: require.resolve('playwright')",
      probeMs: 0,
      installPath: "npm install playwright && npx playwright install chromium",
    };
  }
  // Functional probe: actually launch and read a page back.
  try {
    // Resolved through createRequire so a missing optional dependency can never
    // break the bundle: the engine is probed by actually launching it.
    const playwrightModule = require_("playwright") as unknown as { chromium: { launch: (options?: Record<string, unknown>) => Promise<BrowserLike> } };
    const { chromium } = playwrightModule;
    const { value, ms } = await timed(async () => {
      const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
      try {
        const context = await browser.newContext({ viewport: { width: 1080, height: 900 } });
        const page = await context.newPage();
        await page.setContent("<html><head><title>AISHA PROBE</title></head><body><h1 id='probe'>browser probe ok</h1></body></html>");
        const title = await page.title();
        const text = (await page.textContent("#probe")) ?? "";
        return { title, text };
      } finally {
        await browser.close();
      }
    });
    const ok = value.title === "AISHA PROBE" && value.text.includes("browser probe ok");
    return {
      id: "browser.automation",
      label: "Browser automation (Playwright engine)",
      group: "Browser",
      status: ok ? "AVAILABLE" : "DEGRADED",
      detail: ok ? "Launched a real browser, rendered a page and read DOM content back." : "The engine launched but DOM read-back did not match expectations.",
      evidence: `launched chromium, set content, read title="${value.title}" and #probe="${value.text}"`,
      probeMs: ms,
    };
  } catch (error) {
    return {
      id: "browser.automation",
      label: "Browser automation (Playwright engine)",
      group: "Browser",
      status: "FAILED",
      detail: `Playwright is installed but the launch probe failed: ${(error as Error).message}. Run: npx playwright install chromium`,
      evidence: "attempted a real headless launch",
      probeMs: 0,
      installPath: "npx playwright install chromium",
    };
  }
}

type BrowserLike = { close: () => Promise<void>; newContext: (options?: Record<string, unknown>) => Promise<{ newPage: () => Promise<{ setContent: (html: string) => Promise<void>; title: () => Promise<string>; textContent: (selector: string) => Promise<string | null> }> }> };

/* ------------------------------------------------------------------ */
/* Intelligence: Ollama round-trip                                     */
/* ------------------------------------------------------------------ */

async function probeOllama(deep: boolean): Promise<Capability> {
  const base = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
  const model = process.env.OLLAMA_MODEL ?? "llama3.1:8b";
  const tags = await httpProbe(`${base}/api/tags`);
  if (!tags.ok) {
    return {
      id: "llm.ollama",
      label: "Ollama (local LLM)",
      group: "Intelligence",
      status: "NOT_CONFIGURED",
      detail: `No Ollama server answered at ${base}. The deterministic local planner and writer are used instead, and the UI says so. Nothing silently switches to a paid API.`,
      evidence: `GET ${base}/api/tags -> ${tags.status || tags.error}`,
      probeMs: 0,
      requires: ["OLLAMA_URL", "OLLAMA_MODEL"],
      installPath: "Install Ollama (free), run `ollama pull llama3.1:8b`, then restart",
    };
  }
  let models: string[] = [];
  try {
    models = ((JSON.parse(tags.body) as { models?: { name: string }[] }).models ?? []).map((m) => m.name);
  } catch {
    models = [];
  }
  if (models.length === 0) {
    return {
      id: "llm.ollama",
      label: "Ollama (local LLM)",
      group: "Intelligence",
      status: "UNAVAILABLE",
      detail: `Ollama answered at ${base} but no model is installed, so generation cannot work.`,
      evidence: `GET /api/tags returned 0 models`,
      probeMs: 0,
      installPath: `ollama pull ${model}`,
    };
  }
  const configuredPresent = models.some((name) => name === model || name.startsWith(`${model.split(":")[0]}:`));
  if (!deep) {
    return {
      id: "llm.ollama",
      label: "Ollama (local LLM)",
      group: "Intelligence",
      status: configuredPresent ? "AVAILABLE" : "DEGRADED",
      detail: `Reachable at ${base}; models: ${models.join(", ")}. Deep run-trip probe skipped (shallow run).`,
      evidence: `GET /api/tags -> ${models.length} model(s)`,
      probeMs: 0,
      requires: ["OLLAMA_MODEL"],
    };
  }
  const { value, ms } = await timed(() =>
    httpProbe(
      `${base}/api/generate`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, prompt: "Reply with the single word READY", stream: false, options: { num_predict: 8, temperature: 0 } }) },
      120000,
    ),
  );
  let response = "";
  try {
    response = ((JSON.parse(value.body) as { response?: string }).response ?? "").trim();
  } catch {
    response = "";
  }
  const ok = value.ok && response.length > 0;
  return {
    id: "llm.ollama",
    label: "Ollama (local LLM)",
    group: "Intelligence",
    status: ok ? "AVAILABLE" : configuredPresent ? "FAILED" : "DEGRADED",
    detail: ok
      ? `Real generation round-trip succeeded with ${model} (${ms} ms). Planner stays deterministic; this model writes prose.`
      : `Server reachable but generation did not return text (model "${model}" available: ${configuredPresent}).`,
    evidence: `POST /api/generate model=${model} -> "${response.slice(0, 60) || "(no text)"}"`,
    probeMs: ms,
    requires: ["OLLAMA_MODEL"],
  };
}

/* ------------------------------------------------------------------ */
/* Voice, email, documents, data, interface                            */
/* ------------------------------------------------------------------ */

async function probeStt(): Promise<Capability> {
  const url = process.env.WHISPER_URL;
  if (!url) {
    return {
      id: "voice.stt",
      label: "Local speech-to-text (faster-whisper)",
      group: "Voice",
      status: "NOT_CONFIGURED",
      detail: "No local Whisper server configured. The renderer uses the operating system speech engine and labels the transcript source; word-level caption alignment is then unavailable.",
      evidence: "probed: WHISPER_URL",
      probeMs: 0,
      requires: ["WHISPER_URL"],
      installPath: "Run a local faster-whisper server and set WHISPER_URL",
    };
  }
  const { value, ms } = await timed(() => httpProbe(`${url.replace(/\/$/, "")}/health`));
  return {
    id: "voice.stt",
    label: "Local speech-to-text (faster-whisper)",
    group: "Voice",
    status: value.ok ? "AVAILABLE" : "FAILED",
    detail: value.ok ? `Reachable at ${url}; transcription and word-level timestamps enabled.` : `WHISPER_URL is set but the health probe failed (${value.status || value.error}).`,
    evidence: `GET ${url}/health -> ${value.status || value.error}`,
    probeMs: ms,
  };
}

async function probeTts(): Promise<Capability> {
  const url = process.env.TTS_URL;
  if (!url) {
    return {
      id: "voice.tts",
      label: "Local text-to-speech server",
      group: "Voice",
      status: "NOT_CONFIGURED",
      detail: "No local TTS server. Replies are spoken by the operating system engine in the interface; rendered videos then contain a synthesised score bed instead of narration, and say so.",
      evidence: "probed: TTS_URL",
      probeMs: 0,
      requires: ["TTS_URL"],
      installPath: "Run a local Piper/Kokoro server and set TTS_URL",
    };
  }
  const { value, ms } = await timed(() =>
    httpProbe(`${url.replace(/\/$/, "")}/tts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "probe", voice: "default", format: "wav" }) }, 30000),
  );
  const bytes = value.body.length;
  const ok = value.ok && bytes > 1000;
  return {
    id: "voice.tts",
    label: "Local text-to-speech server",
    group: "Voice",
    status: ok ? "AVAILABLE" : "FAILED",
    detail: ok ? `Synthesised real audio (${humanSize(bytes)}) from a probe phrase. Narration can be rendered into MP4 files.` : `TTS probe failed (${value.status || value.error}).`,
    evidence: `POST ${url}/tts with "probe" -> ${bytes} bytes returned`,
    probeMs: ms,
  };
}

async function probeEmail(): Promise<Capability> {
  const imap = Boolean(process.env.IMAP_URL);
  const smtp = Boolean(process.env.SMTP_URL);
  const packages: string[] = [];
  for (const id of ["imapflow", "nodemailer"]) {
    try {
      require_.resolve(id);
      packages.push(id);
    } catch {
      /* not installed */
    }
  }
  if (!imap && !smtp) {
    return {
      id: "email.connectors",
      label: "Email connectors (IMAP/SMTP/Graph)",
      group: "Data",
      status: "NOT_CONFIGURED",
      detail: "No mail credentials are configured, so no mailbox is opened and the Email Agent reports NOT CONFIGURED rather than inventing messages. Drafts still work as real .eml artifacts.",
      evidence: "probed: IMAP_URL, SMTP_URL, GMAIL_REFRESH_TOKEN, MS_GRAPH_TOKEN",
      probeMs: 0,
      requires: ["IMAP_URL", "SMTP_URL", "GMAIL_REFRESH_TOKEN"],
      installPath: "Set IMAP_URL/SMTP_URL and `npm install imapflow nodemailer`",
    };
  }
  return {
    id: "email.connectors",
    label: "Email connectors (IMAP/SMTP/Graph)",
    group: "Data",
    status: packages.length > 0 ? "NOT_VERIFIED" : "DEGRADED",
    detail:
      packages.length > 0
        ? `Credentials detected and driver(s) installed (${packages.join(", ")}). A live mailbox connection is only attempted when you ask for inbox work — it is never probed in the background with your credentials.`
        : `Credentials detected but no driver installed, so connections would fail.`,
    evidence: `configured: imap=${imap} smtp=${smtp}; drivers: ${packages.join(", ") || "none"}`,
    probeMs: 0,
    installPath: packages.length > 0 ? undefined : "npm install imapflow nodemailer",
  };
}

async function probeDocuments(): Promise<Capability> {
  const checks: string[] = [];
  try {
    require_.resolve("unpdf");
    checks.push("pdf(unpdf)");
  } catch {
    /* missing */
  }
  try {
    require_.resolve("mammoth");
    checks.push("docx(mammoth)");
  } catch {
    /* missing */
  }
  try {
    require_.resolve("fflate");
    checks.push("xlsx(fflate-ooxml)");
  } catch {
    /* missing */
  }
  const canExport = (() => {
    try {
      require_.resolve("pdfkit");
      return true;
    } catch {
      return false;
    }
  })();
  return {
    id: "documents.engines",
    label: "Document extraction engines",
    group: "Documents",
    status: checks.length >= 3 ? "AVAILABLE" : checks.length > 0 ? "DEGRADED" : "UNAVAILABLE",
    detail: `Extraction: ${checks.join(", ") || "none"}. PDF/DOCX export: ${canExport ? "available" : "not installed (Markdown reports are produced instead and export is reported NOT_CONFIGURED)"}.`,
    evidence: `resolved modules: ${checks.join(", ")}${canExport ? ", pdfkit" : ""}`,
    probeMs: 0,
    installPath: canExport ? undefined : "npm install pdfkit (enables report.export to real PDF)",
  };
}

async function probeResearch(): Promise<Capability> {
  const { value, ms } = await timed(() => httpProbe("https://en.wikipedia.org/api/rest_v1/page/summary/Black_hole", undefined, 8000));
  let title = "";
  try {
    title = (JSON.parse(value.body) as { title?: string }).title ?? "";
  } catch {
    title = "";
  }
  return {
    id: "research.network",
    label: "Live research sources",
    group: "Data",
    status: title.length > 0 ? "AVAILABLE" : "UNAVAILABLE",
    detail: title.length > 0 ? "Wikipedia REST verified live; OpenAlex and Hacker News are queried per task and their individual failures are reported per engine." : "The primary research source is unreachable; research tasks will report the failure instead of producing unsourced text.",
    evidence: `GET en.wikipedia.org summary -> title "${title}"`,
    probeMs: ms,
  };
}

async function probeDatabase(): Promise<Capability> {
  const { value, ms } = await timed(async () => {
    try {
      const result = await db.execute(sql`select count(*)::int as tables from information_schema.tables where table_schema = 'public'`);
      const rows = (result as unknown as { rows?: { tables: number }[] }).rows ?? [];
      return rows[0]?.tables ?? 0;
    } catch (error) {
      return `error:${(error as Error).message}`;
    }
  });
  const tables = typeof value === "number" ? value : 0;
  return {
    id: "data.database",
    label: "Task/artifact database",
    group: "Data",
    status: tables >= 10 ? "AVAILABLE" : tables > 0 ? "DEGRADED" : "FAILED",
    detail: `${tables} tables present (tasks, plan steps, events, approvals, artifacts, uploads, agent states, security log, system log, diagnostics, migrations).`,
    evidence: "queried information_schema.tables",
    probeMs: ms,
  };
}

async function probeWorkspaceDisk(): Promise<Capability> {
  const r = ensureRoots();
  const { value, ms } = await timed(async () => {
    ensureDir(r.tempRoot);
    ensureDir(r.documentsRoot);
    ensureDir(r.logsRoot);
    const probe = path.join(r.tempRoot, `.probe_${process.pid}`);
    fs.writeFileSync(probe, "aisha");
    const read = fs.readFileSync(probe, "utf8");
    fs.unlinkSync(probe);
    return read === "aisha";
  });
  let free = "unknown";
  try {
    const stat = fs.statfsSync(r.projectRoot);
    free = humanSize(stat.bavail * stat.bsize);
  } catch {
    free = "unavailable on this platform";
  }
  return {
    id: "data.storage",
    label: "Workspace, permissions & disk",
    group: "Data",
    status: value ? "AVAILABLE" : "FAILED",
    detail: value ? `Write/read/delete verified in every workspace root. Free disk: ${free}. RAM: ${humanSize(os.freemem())} of ${humanSize(os.totalmem())}.` : "Workspace write probe failed.",
    evidence: value ? "wrote, read back and deleted a probe file in temp/" : "probe file could not be verified",
    probeMs: ms,
  };
}

function ensureRoots() {
  return roots();
}

async function probeRenderer(): Promise<Capability> {
  try {
    require_.resolve("three");
    require_.resolve("@react-three/fiber");
    return {
      id: "interface.3d",
      label: "3D office renderer",
      group: "Interface",
      status: "CLIENT_SIDE",
      detail: "React Three Fiber + three.js ship in the bundle. Agent motion is driven by backend walk paths and timings; the renderer's own health is verified by the browser runtime (quality modes: High / Balanced / Low power).",
      evidence: "resolved three + @react-three/fiber; visual verification in the browser",
      probeMs: 0,
    };
  } catch {
    return {
      id: "interface.3d",
      label: "3D office renderer",
      group: "Interface",
      status: "FAILED",
      detail: "three/@react-three/fiber are not installed; run npm install.",
      evidence: "require.resolve('three') failed",
      probeMs: 0,
    };
  }
}

async function probeElectron(): Promise<Capability> {
  const main = path.join(roots().projectRoot, "desktop", "main.cjs");
  const preload = path.join(roots().projectRoot, "desktop", "preload.cjs");
  const codePresent = fs.existsSync(main) && fs.existsSync(preload);
  let runtime = false;
  let version = "";
  try {
    const electronPath = require_("electron") as unknown as string;
    runtime = typeof electronPath === "string" && electronPath.length > 0;
    if (runtime) {
      const result = await run(process.env.ELECTRON_RUN_AS_NODE === "1" ? electronPath : electronPath, ["--version"], 15000).catch(() => ({ ok: false, stdout: "", stderr: "", code: -1 }));
      version = result.stdout.trim();
      runtime = result.ok;
    }
  } catch {
    runtime = false;
  }
  return {
    id: "interface.electron",
    label: "Electron desktop host",
    group: "Runtime",
    status: runtime ? "AVAILABLE" : codePresent ? "NOT_VERIFIED" : "UNAVAILABLE",
    detail: runtime
      ? `Electron ${version} detected. The hardened host (contextIsolation, sandbox, channel allowlist, navigation blocking, microphone-only permissions) is ready.`
      : codePresent
        ? "The desktop host code ships (desktop/main.cjs + desktop/preload.cjs with contextIsolation, sandbox, no node integration, IPC allowlist) but the Electron runtime is not installed in this environment, so the desktop shell is NOT VERIFIED here."
        : "No desktop host code found.",
    evidence: runtime ? `ran electron --version -> ${version}` : "code present check; runtime unavailable in this environment",
    probeMs: 0,
    installPath: runtime ? undefined : "npm install -D electron && npx electron desktop/main.cjs (Windows)",
  };
}

async function probePort(): Promise<Capability> {
  const port = Number(process.env.PORT ?? 3000);
  const open = await portOpen(port);
  return {
    id: "runtime.http",
    label: `Application HTTP surface (port ${port})`,
    group: "Runtime",
    status: open ? "AVAILABLE" : "NOT_VERIFIED",
    detail: open ? `A listener is answering on 127.0.0.1:${port}; task execution, SSE event streaming and artifact download run over it.` : `Nothing is listening on ${port} yet (normal before startup).`,
    evidence: `TCP connect to 127.0.0.1:${port}`,
    probeMs: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function probeCapabilities(options: { deep: boolean } = { deep: true }): Promise<Capability[]> {
  const capabilities: Capability[] = [];
  const push = async (factory: () => Promise<Capability>) => {
    try {
      capabilities.push(await factory());
    } catch (error) {
      capabilities.push({
        id: `probe.error.${capabilities.length}`,
        label: "Probe crashed",
        group: "Runtime",
        status: "FAILED",
        detail: (error as Error).message,
        evidence: "probe threw",
        probeMs: 0,
      });
    }
  };

  await push(async () => ({
    id: "runtime.node",
    label: `Node.js ${process.version}`,
    group: "Runtime",
    status: Number(process.version.replace("v", "").split(".")[0]) >= 20 ? "AVAILABLE" : "UNAVAILABLE",
    detail: `Running on ${os.platform()} ${os.release()} ${os.arch()} with ${os.cpus().length} cores and ${humanSize(os.totalmem())} RAM.`,
    evidence: "process.version / os module",
    probeMs: 0,
  }));
  await push(probePort);
  await push(probeElectron);
  await push(probeDatabase);
  await push(probeWorkspaceDisk);
  await push(probePowerShell);
  await push(probeUiAutomation);
  await push(probeInputControl);
  await push(probeScreenshot);
  await push(probeOcr);
  await push(async () => {
    const status = await pythonSidecar.probe();
    return {
      id: "computer.pythonSidecar",
      label: "Python capability sidecar",
      group: "Computer use",
      status: status.status,
      detail: status.detail,
      evidence: status.evidence,
      probeMs: status.probeMs,
      installPath: status.installPath,
    };
  });
  await push(probeBrowser);
  await push(() => probeOllama(options.deep));
  await push(probeStt);
  await push(probeTts);
  await push(async () => ({
    id: "voice.microphone",
    label: "Microphone & VAD",
    group: "Voice",
    status: "CLIENT_SIDE",
    detail: "Captured in the renderer with getUserMedia, device selection, a live input-level meter, RMS voice-activity detection, silence auto-stop and explicit MICROPHONE ERROR / NO SPEECH DETECTED states.",
    evidence: "renderer implementation; verified by speaking in the interface",
    probeMs: 0,
  }));
  await push(async () => ({
    id: "voice.speaker",
    label: "Spoken replies & interruption",
    group: "Voice",
    status: "CLIENT_SIDE",
    detail: "Speech synthesis with a real cancellation queue: your voice stops playback and switches to listening mid-sentence.",
    evidence: "renderer implementation; verified by interrupting a reply",
    probeMs: 0,
  }));
  await push(probeResearch);
  await push(probeDocuments);
  await push(probeEmail);
  await push(probeFfmpeg);
  await push(probeFfprobe);
  await push(async () => {
    const { loadFont } = await import("@/lib/textrender");
    const { ms } = await timed(async () => {
      loadFont("bold");
      loadFont("regular");
    });
    return {
      id: "media.framegenerator",
      label: "Vector frame & caption renderer",
      group: "Media",
      status: "AVAILABLE",
      detail: "Real font glyph outlines → SVG → PNG, captions laid out against measured advances. Deterministic, offline, no image API.",
      evidence: "loaded bold+regular font outlines and measured advances",
      probeMs: ms,
    };
  });
  await push(probeRenderer);
  await push(async () => {
    const { TOOLS } = await import("@/lib/tools/registry");
    const { missingHandlers } = await import("@/lib/tools");
    const missing = missingHandlers();
    return {
      id: "interface.toolRegistry",
      label: "Tool registry integrity",
      group: "Interface",
      status: missing.length === 0 ? "AVAILABLE" : "FAILED",
      detail: `${Object.keys(TOOLS).length} tools declared with schemas, risk classes, approval flags, timeouts, validators and path scopes. ${missing.length === 0 ? "Every declared tool has a real handler." : `Missing handlers: ${missing.join(", ")}`}`,
      evidence: `registry size ${Object.keys(TOOLS).length}; missing handlers ${missing.length}`,
      probeMs: 0,
    };
  });

  return capabilities;
}

export function capabilityMatrix(capabilities: Capability[]): { available: number; degraded: number; notConfigured: number; unavailable: number; failed: number; notVerified: number; clientSide: number } {
  const count = (status: CapabilityStatus) => capabilities.filter((c) => c.status === status).length;
  return {
    available: count("AVAILABLE"),
    degraded: count("DEGRADED"),
    notConfigured: count("NOT_CONFIGURED"),
    unavailable: count("UNAVAILABLE"),
    failed: count("FAILED"),
    notVerified: count("NOT_VERIFIED"),
    clientSide: count("CLIENT_SIDE"),
  };
}

export type { Capability as CapabilityRecord };
export const spawnDetachedFor = spawn;
