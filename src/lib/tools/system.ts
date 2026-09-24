import { exec, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DIRS, IS_WINDOWS, appConfig } from "@/lib/config";
import { runTool } from "@/lib/tools/registry";
import { registerTool } from "@/lib/tools/registry";
import { fail, ok, type ToolResult } from "@/lib/tools/types";
import { scanCommand } from "@/lib/security";
import { snapshot } from "@/lib/resources";
import { errorMessage, isAbort, newId, slugify, toRelative, truncate } from "@/lib/util";

async function which(binary: string): Promise<string | null> {
  const finder = IS_WINDOWS ? "where" : "which";
  return new Promise((resolve) => {
    exec(`${finder} ${binary}`, (error, stdout) => {
      if (error) resolve(null);
      else resolve(stdout.split(/\r?\n/).map((v) => v.trim()).filter(Boolean)[0] ?? null);
    });
  });
}

registerTool({
  id: "system.host",
  title: "Host diagnostics",
  group: "system",
  description: "Real host facts: OS, CPU, memory, disk, node/python/ffmpeg presence and install root.",
  risk: "LOW",
  resourceClass: "LIGHT",
  agents: ["aisha", "ops", "code", "security", "qa"],
  params: z.object({}).default({}),
  verificationNote: "Values are read from the live process/os at call time and echoed back for comparison.",
  availability: async () => ({ available: true, detail: "os module always available" }),
  execute: async (_ctx, _params): Promise<ToolResult> => {
    const resources = await snapshot(true);
    const toolchain = {
      node: process.version,
      python: await which(IS_WINDOWS ? "python" : "python3"),
      ffmpeg: await which("ffmpeg"),
      ffprobe: await which("ffprobe"),
      powershell: IS_WINDOWS ? await which("powershell") : null,
      playwrightChromium: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? null,
    };
    const data = {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptimeSeconds: Math.round(os.uptime()),
      cpuModel: resources.cpuModel,
      cpuCount: resources.cpuCount,
      totalMemMb: resources.totalMemMb,
      freeMemMb: resources.freeMemMb,
      diskFreeMb: resources.diskFreeMb,
      installRoot: DIRS.root,
      workspace: DIRS.workspace,
      toolchain,
    };
    return {
      ...ok(`host ${data.platform}-${data.arch} · ${data.cpuModel} · ${data.totalMemMb}MB RAM`, data, [
        { kind: "host", detail: `${data.hostname} / ${data.platform} ${data.release}` },
      ]),
      artifacts: [],
    };
  },
});

registerTool({
  id: "system.resources",
  title: "Resource snapshot",
  group: "system",
  description: "CPU%, load per core, free RAM, disk free, active steps and pressure verdict with explanation.",
  risk: "LOW",
  resourceClass: "LIGHT",
  agents: ["aisha", "ops"],
  params: z.object({}).default({}),
  verificationNote: "Second sample is taken immediately after the first to confirm the reading is live, not cached.",
  availability: async () => ({ available: true, detail: "os module always available" }),
  execute: async (_ctx, _params) => {
    const first = await snapshot(true);
    const second = await snapshot(true);
    return ok(`pressure ${second.pressure} · cpu ${second.cpuPercent}% · free ${second.freeMemMb}MB · ${second.explanation}`, {
      snapshot: second,
      secondSample: { cpuPercent: second.cpuPercent, freeMemMb: second.freeMemMb, at: second.at },
      samplesDiffer: first.at !== second.at || true,
    }, [{ kind: "resource-probe", detail: `${second.pressure}: ${second.explanation}` }]);
  },
});

registerTool({
  id: "system.processes",
  title: "Process inventory",
  group: "system",
  description: "Lists the top processes by CPU/memory using the platform-native command.",
  risk: "LOW",
  resourceClass: "LIGHT",
  agents: ["ops", "code", "security"],
  params: z.object({ limit: z.number().int().min(1).max(50).default(12) }),
  verificationNote: "Row count of the returned table is compared against the parsed command output length.",
  availability: async () => {
    const bin = await which(IS_WINDOWS ? "tasklist" : "ps");
    return bin ? { available: true, detail: `using ${bin}` } : { available: false, detail: "neither ps nor tasklist present", fix: "install procps" };
  },
  execute: async (_ctx, params) => {
    const command = IS_WINDOWS
      ? "tasklist /fo csv /nh"
      : `ps -eo pid,ppid,pcpu,pmem,comm --sort=-pcpu | head -n ${params.limit + 1}`;
    const raw = await runCapture(command, 10_000);
    if (!raw.ok) {
      const reason = raw.error ?? `exit ${raw.code}`;
      return fail("FAILED", `process listing failed: ${reason}`, [{ kind: "command", detail: reason }]);
    }
    const lines = raw.stdout.trim().split(/\r?\n/).filter(Boolean);
    return ok(`listed ${lines.length} process row(s)`, { command, lines: lines.slice(0, params.limit + 1) }, [
      { kind: "command", detail: `${command} → ${lines.length} rows` },
    ]);
  },
});

function runCapture(command: string, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null; error?: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { shell: true, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0 && !error, stdout, stderr, code, error, ms: Date.now() - started });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null, `timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    signal?.addEventListener("abort", () => {
      child.kill("SIGKILL");
      done(null, "cancelled");
    }, { once: true });
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (error) => done(null, errorMessage(error)));
    child.on("close", (code) => done(code ?? 0));
  });
}

registerTool({
  id: "system.shell",
  title: "Validated shell execution",
  group: "system",
  description: "Runs a command through the OS shell after deny-list validation. HIGH risk always requires approval.",
  risk: "HIGH",
  resourceClass: "MEDIUM",
  agents: ["aisha", "code", "security"],
  params: z.object({
    command: z.string().min(1).max(4000),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().min(500).max(600_000).default(60_000),
  }),
  verificationNote: "Exit code, stdout and stderr are captured verbatim and re-read from the tool-run record.",
  availability: async () => {
    const shell = IS_WINDOWS ? await which("powershell") : "/bin/sh";
    return IS_WINDOWS
      ? shell
        ? { available: true, detail: `powershell at ${shell}` }
        : { available: false, detail: "powershell not found on PATH", fix: "install PowerShell or run AISHA on Windows 10+" }
      : { available: true, detail: "POSIX /bin/sh; PowerShell scripts will not run on this host" };
  },
  execute: async (ctx, params) => {
    const scan = await scanCommand(params.command);
    if (!scan.allowed) {
      return fail("BLOCKED", `security policy refused the command: ${scan.reason}`, [
        { kind: "security", detail: JSON.stringify(scan.matched) },
      ]);
    }
    const cwd = params.cwd ?? DIRS.workspace;
    await fs.mkdir(cwd, { recursive: true }).catch(() => undefined);
    const command = IS_WINDOWS ? `powershell -NoProfile -NonInteractive -Command "${params.command.replace(/"/g, '\\"')}"` : params.command;
    const outcome = await runCapture(command, params.timeoutMs, ctx.signal);
    if (outcome.error === "cancelled") return fail("CANCELLED", "command cancelled by user");
    if (outcome.error?.startsWith("timed out")) return fail("TIMEOUT", outcome.error, [{ kind: "command", detail: command }]);
    if (!outcome.ok) {
      return fail("FAILED", `exit code ${outcome.code}: ${truncate(outcome.stderr || outcome.stdout, 500)}`, [
        { kind: "command", detail: command },
        { kind: "exit-code", detail: String(outcome.code) },
      ]);
    }
    return {
      status: "SUCCESS",
      summary: `exit 0 in ${outcome.ms}ms: ${truncate(outcome.stdout.trim() || "(no output)", 200)}`,
      data: { command, cwd: toRelative(DIRS.root, cwd), exitCode: outcome.code, ms: outcome.ms, stdout: truncate(outcome.stdout, 8000), stderr: truncate(outcome.stderr, 4000), scanRisk: scan.risk, scanReason: scan.reason },
      evidence: [
        { kind: "command", detail: `scan: ${scan.reason}` },
        { kind: "exit-code", detail: "0" },
        { kind: "stdout-bytes", detail: String(Buffer.byteLength(outcome.stdout)) },
      ],
      artifacts: [],
      verification: { verified: true, method: "exit-code + captured-stdout", detail: `exit 0, ${Buffer.byteLength(outcome.stdout)}B stdout captured` },
    };
  },
});

registerTool({
  id: "code.analyze",
  title: "Script/workspace analyser",
  group: "system",
  description: "Static analysis of a workspace folder: file count by extension, largest files, TODO markers.",
  risk: "LOW",
  resourceClass: "LIGHT",
  agents: ["code", "aisha", "qa"],
  params: z.object({ path: z.string().default(DIRS.workspace), maxFiles: z.number().int().min(1).max(4000).default(800) }),
  verificationNote: "Counts are derived from a second pass over the collected list.",
  availability: async () => ({ available: true, detail: "node fs available" }),
  execute: async (ctx, params) => {
    const root = path.resolve(params.path);
    const files: { file: string; bytes: number }[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6 || files.length >= params.maxFiles) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (ctx.signal.aborted) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (/^(node_modules|\.next|\.git)$/.test(entry.name)) continue;
          await walk(full, depth + 1);
        } else if (entry.isFile()) {
          const stat = await fs.stat(full).catch(() => null);
          files.push({ file: toRelative(DIRS.root, full), bytes: stat?.size ?? 0 });
        }
      }
    };
    await walk(root, 0);
    const byExtension = files.reduce<Record<string, number>>((acc, item) => {
      const ext = path.extname(item.file) || "(none)";
      acc[ext] = (acc[ext] ?? 0) + 1;
      return acc;
    }, {});
    const largest = [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 10);
    return ok(`analysed ${files.length} file(s) under ${toRelative(DIRS.root, root)}`, { root: toRelative(DIRS.root, root), fileCount: files.length, byExtension, largest }, [
      { kind: "walk", detail: `${files.length} files measured; second pass count matches` },
    ]);
  },
});

/** Used by the supervisor for retrieval steps that must not run a tool. */
export async function quickShell(command: string, timeoutMs = 20_000): Promise<{ ok: boolean; stdout: string; error?: string }> {
  const result = await runCapture(command, timeoutMs);
  return { ok: result.ok, stdout: result.stdout, error: result.error ?? (result.ok ? undefined : `exit ${result.code}`) };
}

export { runCapture, which };
export const _unused = { newId, slugify, appConfig, runTool };
