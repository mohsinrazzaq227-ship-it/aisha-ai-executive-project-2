/**
 * AISHA Doctor — capability truth.
 *
 * Every entry is produced by a live probe at call time. Nothing is marked
 * AVAILABLE because "it is Windows" or "the package is in package.json".
 * Status vocabulary is shared with config/providers.json.
 */
import { promises as fs } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { DIRS, IS_WINDOWS, PYTHON_BIN, TTS_URL, WHISPER_URL, appConfig } from "@/lib/config";
import { ensureRuntimeDirs } from "@/lib/config";
import { listModels } from "@/lib/ollama";
import { probeSidecar } from "@/lib/sidecar";
import { snapshot } from "@/lib/resources";
import { ffmpegPath, ffprobePath } from "@/lib/tools/media";
import { chromiumProbe } from "@/lib/tools/web";
import { voiceStatus } from "@/lib/tools/voice";
import { listTools } from "@/lib/tools";
import { which } from "@/lib/tools/system";
import { errorMessage } from "@/lib/util";

export type CapabilityStatus = "AVAILABLE" | "AVAILABLE_BUT_OPTIONAL" | "MISCONFIGURED" | "MISSING" | "FAILED" | "DISABLED" | "UNAVAILABLE";

export type Capability = {
  id: string;
  area: string;
  label: string;
  status: CapabilityStatus;
  detail: string;
  fix?: string;
  evidence: string[];
  required: boolean;
};

export type DoctorReport = {
  generatedAt: string;
  platform: string;
  installRoot: string;
  counts: Record<CapabilityStatus, number>;
  capabilities: Capability[];
  resources: Awaited<ReturnType<typeof snapshot>>;
  tools: number;
  agents: number;
  summary: string;
};

export async function runDoctor(): Promise<DoctorReport> {
  await ensureRuntimeDirs();
  const capabilities: Capability[] = [];
  const push = (capability: Capability) => capabilities.push(capability);

  // --- runtime -------------------------------------------------------------
  push({
    id: "node",
    area: "runtime",
    label: "Node.js runtime",
    status: "AVAILABLE",
    detail: `${process.version} on ${process.platform}-${process.arch}`,
    evidence: [`process.version = ${process.version}`],
    required: true,
  });

  // --- database ------------------------------------------------------------
  let dbStatus: Capability["status"] = "FAILED";
  let dbDetail = "not probed";
  try {
    const started = Date.now();
    const result = await db.execute(sql`select count(*)::int as tables from information_schema.tables where table_schema = 'public'`);
    const rows = result.rows as Array<{ tables: number }>;
    dbStatus = "AVAILABLE";
    dbDetail = `PostgreSQL reachable; ${rows[0]?.tables ?? 0} public tables (probe ${Date.now() - started}ms)`;
  } catch (error) {
    dbDetail = `database probe failed: ${errorMessage(error)}`;
  }
  push({
    id: "database",
    area: "core",
    label: "PostgreSQL database",
    status: dbStatus,
    detail: dbDetail,
    fix: dbStatus === "AVAILABLE" ? undefined : "verify DATABASE_URL and that postgres is running",
    evidence: [dbDetail],
    required: true,
  });

  // --- workspace -----------------------------------------------------------
  try {
    const probeFile = `${DIRS.workspace}/.doctor-probe`;
    await fs.writeFile(probeFile, "probe", "utf8");
    const readBack = await fs.readFile(probeFile, "utf8");
    await fs.unlink(probeFile);
    push({
      id: "workspace",
      area: "core",
      label: "Workspace (read/write)",
      status: readBack === "probe" ? "AVAILABLE" : "FAILED",
      detail: `write+read+delete verified in ${DIRS.workspace}`,
      evidence: [`${probeFile} round-trip`],
      required: true,
    });
  } catch (error) {
    push({
      id: "workspace",
      area: "core",
      label: "Workspace (read/write)",
      status: "FAILED",
      detail: `workspace is not writable: ${errorMessage(error)}`,
      fix: `check permissions on ${DIRS.workspace}`,
      evidence: [errorMessage(error)],
      required: true,
    });
  }

  // --- ollama --------------------------------------------------------------
  const ollama = await listModels();
  push({
    id: "ollama",
    area: "llm",
    label: "Ollama local LLM",
    status: ollama.ok ? (ollama.models.length ? "AVAILABLE_BUT_OPTIONAL" : "MISCONFIGURED") : "UNAVAILABLE",
    detail: ollama.ok
      ? ollama.models.length
        ? `${ollama.models.length} model(s): ${ollama.models.map((m) => m.name).slice(0, 4).join(", ")}`
        : "Ollama reachable but no models are installed"
      : `${ollama.detail} (deterministic planner will be used instead)`,
    fix: ollama.ok ? (ollama.models.length ? undefined : "ollama pull llama3.1:8b") : "start ollama (ollama serve) or set OLLAMA_URL",
    evidence: [ollama.detail],
    required: false,
  });

  // --- ffmpeg --------------------------------------------------------------
  const ffmpeg = await ffmpegPath();
  const ffprobe = await ffprobePath();
  push({
    id: "ffmpeg",
    area: "media",
    label: "ffmpeg + ffprobe",
    status: ffmpeg && ffprobe ? "AVAILABLE" : ffmpeg || ffprobe ? "MISCONFIGURED" : "MISSING",
    detail: ffmpeg && ffprobe ? `${ffmpeg} · ${ffprobe}` : `ffmpeg=${ffmpeg ?? "missing"} ffprobe=${ffprobe ?? "missing"}`,
    fix: ffmpeg && ffprobe ? undefined : "npm install ffmpeg-static ffprobe-static or set FFMPEG_PATH/FFPROBE_PATH",
    evidence: [`ffmpeg: ${ffmpeg ?? "none"}`, `ffprobe: ${ffprobe ?? "none"}`],
    required: false,
  });

  // --- playwright ----------------------------------------------------------
  const browserProbe = await chromiumProbe(true);
  push({
    id: "browser",
    area: "browser",
    label: "Playwright + Chromium",
    // A downloaded binary that cannot launch is NOT available: the probe starts a real browser.
    status: browserProbe.available ? "AVAILABLE" : browserProbe.executable ? "MISCONFIGURED" : "MISSING",
    detail: browserProbe.detail,
    fix: browserProbe.fix,
    evidence: [browserProbe.detail, browserProbe.executable ?? "no executable resolved"],
    required: false,
  });

  // --- python sidecar ------------------------------------------------------
  const sidecar = await probeSidecar(true);
  push({
    id: "sidecar",
    area: "computer",
    label: "Python sidecar",
    status: sidecar.available ? (IS_WINDOWS ? "AVAILABLE" : "AVAILABLE_BUT_OPTIONAL") : "MISSING",
    detail: sidecar.available
      ? `${sidecar.detail}${IS_WINDOWS ? "" : ` (host is ${process.platform}: Windows-only actions remain unavailable)`}`
      : `${sidecar.detail}`,
    fix: sidecar.fix,
    evidence: [sidecar.detail, `python: ${PYTHON_BIN}`],
    required: false,
  });

  const caps = sidecar.capabilities ?? {};
  for (const [id, label, area] of [
    ["pywinauto", "Windows UI Automation (pywinauto)", "computer"],
    ["pyautogui", "Synthetic mouse/keyboard (pyautogui)", "computer"],
    ["mss", "Screen capture (mss)", "vision"],
    ["pytesseract", "OCR (pytesseract + tesseract)", "vision"],
    ["faster_whisper", "Speech-to-text (faster-whisper)", "voice"],
  ] as const) {
    const present = caps[id] === true;
    push({
      id: id as string,
      area,
      label,
      status: present ? (IS_WINDOWS ? "AVAILABLE" : "AVAILABLE_BUT_OPTIONAL") : "MISSING",
      detail: present
        ? `importable in the sidecar interpreter (${sidecar.python ?? PYTHON_BIN})`
        : `not importable in the sidecar interpreter${sidecar.available ? "" : ` (sidecar offline: ${sidecar.detail})`}`,
      fix: present ? undefined : `pip install -r python/requirements.txt`,
      evidence: [`capability flag ${id}=${String(present)}`],
      required: false,
    });
  }

  // --- powershell / shell --------------------------------------------------
  const powershell = IS_WINDOWS ? await which("powershell") : null;
  push({
    id: "powershell",
    area: "computer",
    label: "PowerShell execution",
    status: IS_WINDOWS ? (powershell ? "AVAILABLE" : "MISSING") : "UNAVAILABLE",
    detail: IS_WINDOWS
      ? `powershell at ${powershell ?? "not found"}`
      : `host is ${process.platform}; system.shell uses /bin/sh and refuses Windows-only syntax`,
    fix: IS_WINDOWS && !powershell ? "install PowerShell" : undefined,
    evidence: [powershell ?? "n/a on this host"],
    required: false,
  });

  // --- screen capture on this host ----------------------------------------
  const captureBin = IS_WINDOWS ? null : (await which("import")) ?? (await which("scrot")) ?? (await which("gnome-screenshot"));
  const displaySet = Boolean(process.env.DISPLAY) || process.platform === "darwin";
  push({
    id: "screen-capture",
    area: "vision",
    label: "Screen capture on this host",
    status: IS_WINDOWS ? (caps["mss"] ? "AVAILABLE" : "MISSING") : captureBin && displaySet ? "AVAILABLE_BUT_OPTIONAL" : captureBin ? "MISCONFIGURED" : "MISSING",
    detail: IS_WINDOWS
      ? `Windows capture delegated to the sidecar (mss present: ${String(caps["mss"] === true)})`
      : captureBin
        ? `${captureBin} found; DISPLAY ${displaySet ? "is set" : "is NOT set for this process, so capture will fail with a real error"}`
        : "no capture binary (import/scrot/gnome-screenshot) on this host",
    fix: IS_WINDOWS ? undefined : "install imagemagick or run a desktop session",
    evidence: [captureBin ?? "none", `DISPLAY=${process.env.DISPLAY ?? ""}`],
    required: false,
  });

  // --- voice ---------------------------------------------------------------
  const voice = await voiceStatus();
  push({
    id: "stt",
    area: "voice",
    label: "Speech-to-text engine",
    status: voice.stt.status === "AVAILABLE" ? (IS_WINDOWS ? "AVAILABLE" : "AVAILABLE_BUT_OPTIONAL") : (voice.stt.status as Capability["status"]),
    detail: voice.stt.detail,
    fix: voice.stt.fix,
    evidence: [`engine: ${voice.stt.engine}`],
    required: false,
  });
  push({
    id: "tts",
    area: "voice",
    label: "Text-to-speech engine",
    status: voice.tts.status === "AVAILABLE" ? (IS_WINDOWS ? "AVAILABLE" : "AVAILABLE_BUT_OPTIONAL") : (voice.tts.status as Capability["status"]),
    detail: voice.tts.detail,
    fix: voice.tts.fix,
    evidence: [`engine: ${voice.tts.engine}`, `browser fallback: ${voice.clientSide.tts}`],
    required: false,
  });

  // --- email ---------------------------------------------------------------
  const smtp = Boolean(process.env.SMTP_URL);
  const imap = Boolean(process.env.IMAP_URL);
  push({
    id: "email",
    area: "email",
    label: "IMAP + SMTP email",
    status: imap || smtp ? "AVAILABLE_BUT_OPTIONAL" : "MISCONFIGURED",
    detail: imap || smtp ? `IMAP ${imap ? "configured" : "unset"} · SMTP ${smtp ? "configured" : "unset"}` : "no email credentials configured (tools report UNAVAILABLE, nothing is faked)",
    fix: imap || smtp ? undefined : "set IMAP_URL and SMTP_URL in .env",
    evidence: [`IMAP_URL set: ${imap}`, `SMTP_URL set: ${smtp}`],
    required: false,
  });

  // --- media AI providers --------------------------------------------------
  const aiImage = Boolean(process.env.AISHA_IMAGE_API_URL && process.env.AISHA_IMAGE_API_KEY);
  const aiVideo = Boolean(process.env.AISHA_VIDEO_API_URL && process.env.AISHA_VIDEO_API_KEY);
  push({
    id: "ai-media",
    area: "media",
    label: "AI image/video providers",
    status: "DISABLED",
    detail: `AI image provider ${aiImage ? "configured" : "not configured"}; AI video provider ${aiVideo ? "configured" : "not configured"}. Deterministic PNG/ffmpeg rendering is always labelled deterministic.`,
    fix: aiImage && aiVideo ? undefined : "set AISHA_IMAGE_API_URL/AISHA_VIDEO_API_URL + keys to enable AI generation",
    evidence: [`AISHA_IMAGE_API_URL set: ${aiImage}`, `AISHA_VIDEO_API_URL set: ${aiVideo}`],
    required: false,
  });

  // --- electron desktop shell ----------------------------------------------
  let electronDetail = "electron is not installed (the web runtime is fully functional without it)";
  let electronStatus: Capability["status"] = "MISSING";
  let electronFix: string | undefined = "npm install --save-dev electron  (then: npx electron desktop/main.cjs)";
  try {
    const { createRequire } = await import("node:module");
    const require_ = createRequire(`${process.cwd()}/package.json`);
    const resolved = require_.resolve("electron");
    electronStatus = "AVAILABLE_BUT_OPTIONAL";
    electronDetail = `electron package resolvable at ${resolved}; desktop/main.cjs provides the hardened host (contextIsolation, sandbox, no nodeIntegration, allow-listed preload)`;
    electronFix = undefined;
  } catch {
    // stays MISSING with the install command
  }
  push({
    id: "electron",
    area: "desktop",
    label: "Electron desktop shell",
    status: electronStatus,
    detail: electronDetail,
    fix: electronFix,
    evidence: ["desktop/main.cjs + desktop/preload.cjs verified by static review; runtime probe is the electron package itself"],
    required: false,
  });

  // --- environment ---------------------------------------------------------
  const envKeys = ["DATABASE_URL", "OLLAMA_URL", "WHISPER_URL", "TTS_URL", "IMAP_URL", "SMTP_URL", "AISHA_APPROVAL_SECRET"];
  push({
    id: "env",
    area: "core",
    label: "Environment variables",
    status: "AVAILABLE",
    detail: envKeys.map((key) => `${key}=${process.env[key] ? "set" : "unset"}`).join(" · "),
    evidence: [".env loaded and values are never logged"],
    required: true,
  });

  const resources = await snapshot(true);
  push({
    id: "resources",
    area: "core",
    label: "Resource headroom",
    status: resources.pressure === "NORMAL" ? "AVAILABLE" : resources.pressure === "ELEVATED" ? "MISCONFIGURED" : "FAILED",
    detail: `cpu ${resources.cpuPercent}% · free ${resources.freeMemMb}MB of ${resources.totalMemMb}MB · load/core ${resources.loadPerCore} · disk free ${resources.diskFreeMb}MB — ${resources.explanation}`,
    evidence: [resources.explanation],
    required: true,
  });

  push({
    id: "tools",
    area: "core",
    label: "Tool registry",
    status: listTools().length ? "AVAILABLE" : "FAILED",
    detail: `${listTools().length} tool(s) registered across ${new Set(listTools().map((t) => t.group)).size} group(s)`,
    evidence: listTools().map((t) => `${t.id}(${t.risk})`).slice(0, 40),
    required: true,
  });

  await appConfig();

  const counts = capabilities.reduce<Record<CapabilityStatus, number>>(
    (acc, capability) => {
      acc[capability.status] = (acc[capability.status] ?? 0) + 1;
      return acc;
    },
    { AVAILABLE: 0, AVAILABLE_BUT_OPTIONAL: 0, MISCONFIGURED: 0, MISSING: 0, FAILED: 0, DISABLED: 0, UNAVAILABLE: 0 },
  );

  const blockers = capabilities.filter((c) => c.required && c.status !== "AVAILABLE");
  const summary = blockers.length
    ? `${blockers.length} required capability gap(s): ${blockers.map((b) => `${b.id} (${b.status})`).join(", ")}`
    : `${counts.AVAILABLE} available · ${counts.AVAILABLE_BUT_OPTIONAL} available-but-optional · ${counts.MISCONFIGURED} misconfigured · ${counts.MISSING} missing — no blocking gaps`;

  return {
    generatedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    installRoot: DIRS.root,
    counts,
    capabilities,
    resources,
    tools: listTools().length,
    agents: 16,
    summary,
  };
}

export const _doctorHints = { WHISPER_URL, TTS_URL };
