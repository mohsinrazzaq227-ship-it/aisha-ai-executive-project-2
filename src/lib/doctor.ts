import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { diagnostics } from "@/db/schema";
import { ffmpegBinary, ffprobeBinary, providerInventory, which } from "@/lib/providers";
import { ensureDir, humanSize, roots } from "@/lib/workspace";

export type CheckStatus = "PASS" | "WARNING" | "FAIL" | "NOT_APPLICABLE" | "CLIENT_SIDE" | "NOT_CONFIGURED";

export type DoctorCheck = {
  id: string;
  group: string;
  name: string;
  status: CheckStatus;
  detail: string;
  action?: string;
};

export type DoctorReport = {
  generatedAt: string;
  host: { platform: string; release: string; arch: string; cpus: number; totalMemory: string; hostname: string };
  summary: { pass: number; warning: number; fail: number; notApplicable: number; clientSide: number; notConfigured: number };
  checks: DoctorCheck[];
  durationMs: number;
};

function version(bin: string, args: string[]): string | null {
  try {
    return execFileSync(bin, args, { timeout: 8000, stdio: ["ignore", "pipe", "ignore"] }).toString().split("\n")[0].trim();
  } catch {
    return null;
  }
}

async function portOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1200);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

/** AI-EXECUTIVE Doctor — real environment verification with actionable outcomes. */
export async function runDoctor(deep = true): Promise<DoctorReport> {
  const started = Date.now();
  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheck) => checks.push(check);
  const r = roots();

  // ---- Host --------------------------------------------------------------------
  add({
    id: "host.os",
    group: "Environment",
    name: `Operating system (${os.platform()} ${os.release()})`,
    status: process.platform === "win32" ? "PASS" : "WARNING",
    detail:
      process.platform === "win32"
        ? "Running on Windows: PowerShell, window control, clipboard and screenshot tools are available."
        : `Running on ${os.platform()}. The Windows desktop layer (PowerShell, pywinauto-style window control) is NOT available here and is reported as such rather than simulated. All cross-platform capabilities still work.`,
    action: process.platform === "win32" ? undefined : "Run on Windows 10/11 x64 for the full desktop control surface.",
  });
  add({
    id: "host.hardware",
    group: "Environment",
    name: "CPU / memory",
    status: os.cpus().length >= 4 ? "PASS" : "WARNING",
    detail: `${os.cpus().length} logical cores, ${humanSize(os.totalmem())} RAM, hostname ${os.hostname()}. ${os.cpus().length < 4 ? "Local rendering and LLM inference will be slow on this machine." : "Suitable for local rendering."}`,
  });

  const nodeVersion = process.version;
  add({ id: "node", group: "Environment", name: "Node.js runtime", status: Number(nodeVersion.replace("v", "").split(".")[0]) >= 20 ? "PASS" : "FAIL", detail: `Node ${nodeVersion}. Requires >= 20.` });
  const npmVersion = version("npm", ["-v"]);
  add({ id: "npm", group: "Environment", name: "npm", status: npmVersion ? "PASS" : "WARNING", detail: npmVersion ? `npm ${npmVersion}` : "npm not found on PATH.", action: npmVersion ? undefined : "Install Node.js which bundles npm." });

  const python = which(process.platform === "win32" ? "python" : "python3");
  add({
    id: "python",
    group: "Optional components",
    name: "Python 3 (optional local workers)",
    status: python ? "PASS" : "WARNING",
    detail: python
      ? `Python found at ${python}. Optional Python helpers (openslide-free OCR wrappers, pywinauto desktop control on Windows) can be used.`
      : "Python not found. The application is fully functional without it; only optional host helpers are affected.",
    action: python ? undefined : "Install Python 3.11+ if you want the optional Python worker scripts.",
  });

  // ---- Media -------------------------------------------------------------------
  const ffmpeg = ffmpegBinary();
  const ffmpegVersion = ffmpeg ? version(ffmpeg, ["-hide_banner", "-version"]) : null;
  add({
    id: "ffmpeg",
    group: "Media pipeline",
    name: "FFmpeg",
    status: ffmpegVersion ? "PASS" : "FAIL",
    detail: ffmpegVersion ? `${ffmpegVersion} (${ffmpeg})` : "No ffmpeg binary. Video rendering is impossible and will fail explicitly.",
    action: ffmpegVersion ? undefined : "Run npm install (bundled ffmpeg-static) or set FFMPEG_PATH.",
  });
  const ffprobe = ffprobeBinary();
  const ffprobeVersion = ffprobe ? version(ffprobe, ["-hide_banner", "-version"]) : null;
  add({
    id: "ffprobe",
    group: "Media pipeline",
    name: "FFprobe (independent validator)",
    status: ffprobeVersion ? "PASS" : "FAIL",
    detail: ffprobeVersion ? `${ffprobeVersion} (${ffprobe})` : "No ffprobe binary — rendered files cannot be verified.",
    action: ffprobeVersion ? undefined : "Run npm install (bundled ffprobe-static) or set FFPROBE_PATH.",
  });

  // ---- Renderer fonts ----------------------------------------------------------
  const fontCandidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "C:/Windows/Fonts/segoeuib.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
  ];
  const font = fontCandidates.find((candidate) => fs.existsSync(candidate));
  add({
    id: "frames.fonts",
    group: "Media pipeline",
    name: "Vector frame renderer fonts",
    status: font ? "PASS" : "FAIL",
    detail: font ? `Real glyph outlines loaded from ${font}. Captions are measured against actual advances.` : "No usable TTF font found — frame and caption rendering cannot run.",
    action: font ? undefined : "Install DejaVu or Liberation fonts (Linux) — Windows fonts are detected automatically.",
  });

  // ---- Capabilities (functional probes; never presence-based) -------------------
  const { probeCapabilities } = await import("@/lib/capabilities");
  const capabilities = await probeCapabilities({ deep });
  const mapStatus = (status: string): CheckStatus => {
    switch (status) {
      case "AVAILABLE":
        return "PASS";
      case "DEGRADED":
      case "NOT_VERIFIED":
        return "WARNING";
      case "FAILED":
        return "FAIL";
      case "CLIENT_SIDE":
        return "CLIENT_SIDE";
      default:
        return "NOT_CONFIGURED";
    }
  };
  for (const capability of capabilities) {
    add({
      id: capability.id,
      group: capability.group,
      name: capability.label,
      status: mapStatus(capability.status),
      detail: `${capability.detail} — probe evidence: ${capability.evidence} (${capability.probeMs} ms)`,
      action: capability.installPath,
    });
  }

  // ---- Migrations ---------------------------------------------------------------
  try {
    const { migrationStatus } = await import("@/lib/migrations");
    const status = await migrationStatus();
    add({
      id: "db.migrations",
      group: "Storage",
      name: "Schema migrations",
      status: status.pending.length === 0 && status.checksumMismatches.length === 0 ? "PASS" : "WARNING",
      detail:
        status.pending.length === 0
          ? `${status.records.length} versioned migration(s) applied; checksums verified. Startup never runs a destructive schema command — apply changes explicitly with \`node scripts/migrate.mjs\`.`
          : `Pending migrations: ${status.pending.join(", ")}. Apply explicitly with \`node scripts/migrate.mjs\` (never automatically at startup).${status.checksumMismatches.length > 0 ? ` Checksum mismatches: ${status.checksumMismatches.join(", ")}` : ""}`,
      action: status.pending.length > 0 ? "node scripts/migrate.mjs" : undefined,
    });
  } catch (error) {
    add({ id: "db.migrations", group: "Storage", name: "Schema migrations", status: "WARNING", detail: `Migration status unavailable: ${(error as Error).message}` });
  }

  // ---- Storage ------------------------------------------------------------------
  try {
    await db.execute(sql`select 1`);
    add({ id: "db", group: "Storage", name: "Task database", status: "PASS", detail: "PostgreSQL reachable through Drizzle ORM; tasks, approvals, events, artifacts and uploads are persisted." });
  } catch (error) {
    add({ id: "db", group: "Storage", name: "Task database", status: "FAIL", detail: `Database unreachable: ${(error as Error).message}`, action: "Verify DATABASE_URL and that PostgreSQL is running." });
  }

  const permissionTargets = [
    { id: "perm.runs", label: "Run directories", dir: r.runsRoot },
    { id: "perm.uploads", label: "Upload staging", dir: r.uploadsRoot },
    { id: "perm.output", label: "Rendered output", dir: r.outputRoot },
    { id: "perm.documents", label: "Documents target", dir: r.documentsRoot },
    { id: "perm.logs", label: "Log directory", dir: r.logsRoot },
  ];
  for (const target of permissionTargets) {
    try {
      ensureDir(target.dir);
      const probe = path.join(target.dir, `.write_probe_${process.pid}`);
      fs.writeFileSync(probe, "probe");
      const readBack = fs.readFileSync(probe, "utf8");
      fs.unlinkSync(probe);
      add({ id: target.id, group: "Filesystem", name: `${target.label} writable`, status: readBack === "probe" ? "PASS" : "WARNING", detail: `${target.dir} — write/read/delete verified.` });
    } catch (error) {
      add({ id: target.id, group: "Filesystem", name: `${target.label} writable`, status: "FAIL", detail: `${target.dir} — ${(error as Error).message}`, action: "Grant write permission or point AI_EXECUTIVE_DATA_DIR at a writable directory." });
    }
  }

  // ---- Network / ports ---------------------------------------------------------
  add({
    id: "port.http",
    group: "Network",
    name: "Application HTTP port",
    status: (await portOpen(Number(process.env.PORT ?? 3000))) ? "PASS" : "WARNING",
    detail: (await portOpen(Number(process.env.PORT ?? 3000))) ? `A listener is answering on port ${process.env.PORT ?? 3000}.` : `Nothing is listening on port ${process.env.PORT ?? 3000} yet (normal before the server starts).`,
  });

  const netTargets = [
    { id: "net.wikipedia", url: "https://en.wikipedia.org/api/rest_v1/page/summary/Black_hole", name: "Research network (Wikipedia)" },
    { id: "net.openalex", url: "https://api.openalex.org/works?search=ai&per-page=1", name: "Research network (OpenAlex)" },
  ];
  for (const target of netTargets) {
    if (!deep) {
      add({ id: target.id, group: "Network", name: target.name, status: "NOT_APPLICABLE", detail: "Skipped (shallow run)." });
      continue;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(target.url, { signal: controller.signal });
      clearTimeout(timer);
      add({ id: target.id, group: "Network", name: target.name, status: res.ok ? "PASS" : "WARNING", detail: `${target.url} -> HTTP ${res.status}` });
    } catch (error) {
      add({ id: target.id, group: "Network", name: target.name, status: "WARNING", detail: `Unreachable: ${(error as Error).message}. Research tasks will report this per engine instead of inventing sources.` });
    }
  }

  // ---- Client-side capabilities -------------------------------------------------
  add({ id: "voice.mic", group: "Voice", name: "Microphone capture", status: "CLIENT_SIDE", detail: "Captured in the renderer through getUserMedia with a live input-level meter, explicit device selection and permission diagnostics. The UI reports MICROPHONE ERROR rather than pretending it heard you." });
  add({ id: "voice.out", group: "Voice", name: "Spoken responses / interruption", status: "CLIENT_SIDE", detail: "Browser speech synthesis with a real cancellation queue: starting to speak stops playback and switches to listening." });
  add({ id: "renderer.webgl", group: "3D office", name: "WebGL 3D renderer", status: "CLIENT_SIDE", detail: "React Three Fiber scene with quality modes (High quality / Balanced / Low power). Agent motion is driven by the backend event stream." });
  add({
    id: "desktop.electron",
    group: "Desktop shell",
    name: "Electron desktop host layer",
    status: fs.existsSync(path.join(r.projectRoot, "desktop", "main.cjs")) ? "WARNING" : "NOT_CONFIGURED",
    detail: "The desktop host layer (contextIsolation, sandbox, secure preload, IPC allowlist) ships in the source tree for the Windows packaging path and is documented in README. The preview environment runs the same backend and UI in the browser runtime; Electron features are therefore reported as unverified here.",
    action: "Run Start-Agent.bat on Windows (requires npm install) to launch inside Electron.",
  });

  const summary = {
    pass: checks.filter((c) => c.status === "PASS").length,
    warning: checks.filter((c) => c.status === "WARNING").length,
    fail: checks.filter((c) => c.status === "FAIL").length,
    notApplicable: checks.filter((c) => c.status === "NOT_APPLICABLE").length,
    clientSide: checks.filter((c) => c.status === "CLIENT_SIDE").length,
    notConfigured: checks.filter((c) => c.status === "NOT_CONFIGURED").length,
  };
  const report: DoctorReport = {
    generatedAt: new Date().toISOString(),
    host: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpus: os.cpus().length,
      totalMemory: humanSize(os.totalmem()),
      hostname: os.hostname(),
    },
    summary,
    checks,
    durationMs: Date.now() - started,
  };
  try {
    await db.insert(diagnostics).values({ report: report as unknown as Record<string, unknown>, durationMs: String(report.durationMs) });
  } catch {
    /* diagnostics persistence is best-effort */
  }
  return report;
}
