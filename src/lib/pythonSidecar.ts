import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { logEvent, writeLogFile } from "@/lib/logging";
import { roots } from "@/lib/workspace";

/**
 * Managed Python capability sidecar.
 *
 * Why a sidecar at all: on Windows the mature, battle-tested automation
 * libraries (pywinauto UI Automation, pyautogui input, pytesseract OCR,
 * faster-whisper STT) are Python. Where that is genuinely better than anything
 * native Node can do, AISHA drives a real, supervised Python process instead of
 * pretending the capability exists.
 *
 * The sidecar is strictly optional: if Python or its packages are missing, the
 * capability registry reports NOT_CONFIGURED/UNAVAILABLE and every tool that
 * needs it says so. It never fabricates a result.
 *
 * Protocol: newline-delimited JSON over stdin/stdout.
 *   -> {"id":"...","action":"health","params":{},"timeoutMs":5000}
 *   <- {"id":"...","ok":true,"result":{...},"ms":12}
 */

export type SidecarResponse = { id: string; ok: boolean; result?: unknown; error?: string; ms?: number };

export type SidecarStatus = {
  available: boolean;
  python: string | null;
  pythonVersion: string | null;
  capabilities: string[];
  restarts: number;
  lastError: string | null;
};

export type SidecarProbe = {
  status: "AVAILABLE" | "DEGRADED" | "NOT_CONFIGURED" | "UNAVAILABLE" | "FAILED";
  detail: string;
  evidence: string;
  probeMs: number;
  installPath?: string;
};

type Pending = { resolve: (value: SidecarResponse) => void; timer: ReturnType<typeof setTimeout> };

class PythonSidecar {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private buffer = "";
  private starting: Promise<void> | null = null;
  private pythonPath: string | null = null;
  private pythonVersion: string | null = null;
  private capabilityList: string[] = [];
  private restarts = 0;
  private restartWindow: number[] = [];
  private lastError: string | null = null;

  private workerPath(): string {
    return path.join(roots().projectRoot, "python", "worker", "aisha_worker.py");
  }

  resolvePython(): string | null {
    if (this.pythonPath) return this.pythonPath;
    const candidates = [
      process.env.AI_EXECUTIVE_PYTHON,
      process.platform === "win32" ? "py" : "python3",
      "python3",
      "python",
    ].filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
      try {
        const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
        const args = candidate === "py" ? ["-3", "--version"] : ["--version"];
        const out = execFileSync(candidate, args, { timeout: 8000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
        if (out.toLowerCase().includes("python")) {
          this.pythonPath = candidate;
          this.pythonVersion = out;
          return candidate;
        }
      } catch {
        /* try the next candidate */
      }
    }
    return null;
  }

  status(): SidecarStatus {
    return {
      available: Boolean(this.child && !this.child.killed && this.capabilityList.length > 0),
      python: this.pythonPath,
      pythonVersion: this.pythonVersion,
      capabilities: this.capabilityList,
      restarts: this.restarts,
      lastError: this.lastError,
    };
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: SidecarResponse | null = null;
    try {
      parsed = JSON.parse(trimmed) as SidecarResponse;
    } catch {
      writeLogFile("computer", "warn", `python sidecar emitted non-JSON output: ${trimmed.slice(0, 200)}`);
      return;
    }
    if (!parsed?.id) return;
    const entry = this.pending.get(parsed.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(parsed.id);
    entry.resolve(parsed);
  }

  private failPending(reason: string): void {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.resolve({ id, ok: false, error: reason });
    }
  }

  private async start(): Promise<void> {
    if (this.child && !this.child.killed) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const python = this.resolvePython();
      if (!python) {
        this.lastError = "No Python interpreter found (AI_EXECUTIVE_PYTHON / python3 / python / py).";
        return;
      }
      const worker = this.workerPath();
      if (!fs.existsSync(worker)) {
        this.lastError = `Sidecar worker script missing: ${worker}`;
        return;
      }
      // Crash-loop guard: no more than 5 starts per minute.
      const now = Date.now();
      this.restartWindow = this.restartWindow.filter((ts) => now - ts < 60000);
      if (this.restartWindow.length >= 5) {
        this.lastError = "Sidecar restarted 5 times in under a minute; automatic restart paused to avoid a crash loop.";
        return;
      }
      this.restartWindow.push(now);
      const args = python === "py" ? ["-3", "-u", worker] : ["-u", worker];
      const child = spawn(python, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      this.child = child;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        this.buffer += chunk;
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";
        for (const line of lines) this.handleLine(line);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => writeLogFile("computer", "info", `[python] ${String(chunk).trim().slice(0, 400)}`));
      child.on("exit", (code, signal) => {
        this.failPending(`Python sidecar exited (code ${code ?? "null"}, signal ${signal ?? "none"}).`);
        this.child = null;
        this.restarts += 1;
        this.capabilityList = [];
        writeLogFile("computer", "warn", `python sidecar exited code=${code} signal=${signal}`);
      });
      child.on("error", (error) => {
        this.lastError = `Sidecar spawn failed: ${error.message}`;
        this.failPending(this.lastError);
        this.child = null;
      });
      const hello = await this.send("health", {}, 15000);
      if (hello.ok && hello.result) {
        const result = hello.result as { python?: string; capabilities?: string[] };
        this.capabilityList = result.capabilities ?? [];
        this.pythonVersion = result.python ?? this.pythonVersion;
        this.lastError = null;
        void logEvent("computer", `Python sidecar online (${this.pythonVersion}). Capabilities: ${this.capabilityList.join(", ") || "none detected"}`);
      } else {
        this.lastError = hello.error ?? "health handshake failed";
      }
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private send(action: string, params: Record<string, unknown>, timeoutMs: number): Promise<SidecarResponse> {
    const child = this.child;
    const id = randomUUID();
    if (!child || child.killed) return Promise.resolve({ id, ok: false, error: this.lastError ?? "Sidecar is not running." });
    return new Promise<SidecarResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, ok: false, error: `Sidecar action "${action}" timed out after ${timeoutMs} ms.` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, action, params, timeoutMs })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ id, ok: false, error: `Failed writing to the sidecar: ${(error as Error).message}` });
      }
    });
  }

  /** Ensure the process is alive (spawning if needed) then perform one action. */
  async request(action: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<SidecarResponse> {
    if (!this.child) await this.start();
    if (!this.child) return { id: randomUUID(), ok: false, error: this.lastError ?? "Python sidecar unavailable." };
    return this.send(action, params, timeoutMs);
  }

  async health(): Promise<{ ok: boolean; version: string | null; capabilities: string[] }> {
    await this.start();
    return { ok: Boolean(this.child), version: this.pythonVersion, capabilities: this.capabilityList };
  }

  async probe(): Promise<SidecarProbe> {
    const started = Date.now();
    const python = this.resolvePython();
    if (!python) {
      return {
        status: "NOT_CONFIGURED",
        detail: "No Python interpreter on PATH. Optional Python-backed helpers (pywinauto UI Automation, pyautogui input, pytesseract OCR) are therefore disabled; the native PowerShell layer remains available on Windows.",
        evidence: "probed AI_EXECUTIVE_PYTHON, python3, python, py",
        probeMs: Date.now() - started,
        installPath: "Install Python 3.11+ and set AI_EXECUTIVE_PYTHON if it is not on PATH",
      };
    }
    try {
      const result = await this.request("health", {}, 20000);
      if (!result.ok) {
        return {
          status: "FAILED",
          detail: `Python is installed at ${python} but the sidecar handshake failed: ${result.error}`,
          evidence: `spawned ${python} -u python/worker/aisha_worker.py and sent health`,
          probeMs: Date.now() - started,
        };
      }
      const payload = (result.result ?? {}) as { python?: string; capabilities?: string[]; platform?: string };
      const capabilities = payload.capabilities ?? [];
      const meaningful = capabilities.filter((capability) => !["stdlib"].includes(capability));
      return {
        status: meaningful.length > 0 ? "AVAILABLE" : "DEGRADED",
        detail:
          meaningful.length > 0
            ? `Sidecar online on ${payload.python ?? python}. Detected capabilities: ${meaningful.join(", ")}.`
            : `Sidecar online on ${payload.python ?? python} but no automation packages are installed, so it can only report diagnostics. Install pywinauto/pyautogui/pytesseract to enable those paths.`,
        evidence: `health handshake returned capabilities: ${capabilities.join(", ") || "none"}`,
        probeMs: Date.now() - started,
        installPath: meaningful.length > 0 ? undefined : "pip install pywinauto pyautogui pytesseract pillow mss",
      };
    } catch (error) {
      return {
        status: "FAILED",
        detail: `Sidecar probe threw: ${(error as Error).message}`,
        evidence: "probe exception",
        probeMs: Date.now() - started,
      };
    }
  }

  stop(): void {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* already gone */
      }
      this.child = null;
    }
    this.failPending("Sidecar stopped.");
  }
}

const globalForSidecar = globalThis as typeof globalThis & { __aishaPythonSidecar?: PythonSidecar };
export const pythonSidecar = globalForSidecar.__aishaPythonSidecar ?? new PythonSidecar();
globalForSidecar.__aishaPythonSidecar = pythonSidecar;
