/**
 * Python sidecar bridge — Project 2's stdin/stdout JSON protocol, kept intact.
 *
 * The worker is spawned on demand, speaks newline-delimited JSON, and returns
 * `ok:false` with an explicit `unavailable` reason + install command when a
 * capability cannot run. Nothing is simulated: if the sidecar cannot start, every
 * dependent tool reports UNAVAILABLE with the real reason captured here.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { PYTHON_BIN, SIDECAR_PATH } from "@/lib/config";
import { newId, errorMessage } from "@/lib/util";

export type SidecarResponse = {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  unavailable?: string;
  fix?: string;
  error?: string;
  ms?: number;
};

let lastProbe: { at: number; value: SidecarProbe } | null = null;

export type SidecarProbe = {
  available: boolean;
  detail: string;
  fix?: string;
  python?: string;
  capabilities?: Record<string, boolean>;
};

export async function sidecarFileExists(): Promise<boolean> {
  try {
    await fs.access(SIDECAR_PATH);
    return true;
  } catch {
    return false;
  }
}

export async function invokeSidecar(
  action: string,
  params: Record<string, unknown> = {},
  timeoutMs = 20_000,
  signal?: AbortSignal,
): Promise<SidecarResponse> {
  const id = newId("req");
  if (!(await sidecarFileExists())) {
    return {
      id,
      ok: false,
      unavailable: `python sidecar not found at ${SIDECAR_PATH}`,
      fix: "ensure python/worker/aisha_worker.py exists (it ships with AISHA)",
    };
  }
  return new Promise<SidecarResponse>((resolve) => {
    let settled = false;
    const child = spawn(PYTHON_BIN, [SIDECAR_PATH, "--one-shot"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    let stdout = "";
    let stderr = "";
    const done = (response: SidecarResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(response);
    };
    const timer = setTimeout(
      () => done({ id, ok: false, unavailable: `sidecar timed out after ${timeoutMs}ms`, fix: `check ${PYTHON_BIN} and sidecar dependencies` }),
      timeoutMs,
    );
    signal?.addEventListener("abort", () => done({ id, ok: false, error: "cancelled" }), { once: true });

    child.on("error", (error) =>
      done({
        id,
        ok: false,
        unavailable: `cannot start "${PYTHON_BIN}": ${errorMessage(error)}`,
        fix: "install Python 3.9+ or set AISHA_PYTHON to an interpreter path",
      }),
    );
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", () => {
      const line = stdout.trim().split("\n").filter(Boolean).pop();
      if (!line) {
        done({ id, ok: false, unavailable: `sidecar produced no response: ${stderr.trim().slice(0, 400) || "empty stderr"}` });
        return;
      }
      try {
        done(JSON.parse(line) as SidecarResponse);
      } catch {
        done({ id, ok: false, unavailable: `sidecar returned non-JSON: ${line.slice(0, 300)}` });
      }
    });
    child.stdin.write(`${JSON.stringify({ id, action, params, timeoutMs })}\n`);
    child.stdin.end();
  });
}

export async function probeSidecar(force = false): Promise<SidecarProbe> {
  if (!force && lastProbe && Date.now() - lastProbe.at < 30_000) return lastProbe.value;
  const response = await invokeSidecar("health", {}, 25_000);
  let value: SidecarProbe;
  if (response.ok) {
    const result = response.result ?? {};
    value = {
      available: true,
      detail: String(result.detail ?? "sidecar online"),
      python: String(result.python ?? ""),
      capabilities: (result.capabilities as Record<string, boolean>) ?? {},
    };
  } else {
    value = {
      available: false,
      detail: response.unavailable ?? response.error ?? "sidecar unavailable",
      fix: response.fix ?? "pip install -r python/requirements.txt",
    };
  }
  lastProbe = { at: Date.now(), value };
  return value;
}
