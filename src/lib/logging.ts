import fs from "node:fs";
import path from "node:path";
import { db } from "@/db";
import { systemLog } from "@/db/schema";
import { ensureDir, roots } from "@/lib/workspace";

export type LogChannel =
  | "supervisor"
  | "agents"
  | "voice"
  | "browser"
  | "computer"
  | "media"
  | "security"
  | "errors"
  | "uploads"
  | "system";

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const SECRET_PATTERN =
  /(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|AIza[0-9A-Za-z_-]{12,}|(?<=(password|passwd|token|secret|api[_-]?key|authorization)"?\s*[:=]\s*")[^"]{4,})/gi;

export function redact(input: string): string {
  return input.replace(SECRET_PATTERN, "[REDACTED]");
}

function rotate(file: string): void {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    /* logging must never throw */
  }
}

/** Append to a real rotating log file under logs/ (no secrets, ever). */
export function writeLogFile(channel: LogChannel, level: string, message: string, data?: unknown): void {
  try {
    const dir = ensureDir(roots().logsRoot);
    const file = path.join(dir, `${channel}.log`);
    rotate(file);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      channel,
      message: redact(message),
      data: data ? JSON.parse(redact(JSON.stringify(data))) : undefined,
    });
    fs.appendFileSync(file, `${line}\n`);
    if (level === "error" && channel !== "errors") {
      const errFile = path.join(dir, "errors.log");
      rotate(errFile);
      fs.appendFileSync(errFile, `${line}\n`);
    }
  } catch {
    /* swallow: logging must never break a task */
  }
}

export async function logEvent(
  channel: LogChannel,
  message: string,
  options: { level?: string; taskId?: string; agentId?: string; data?: Record<string, unknown> } = {},
): Promise<void> {
  const level = options.level ?? "info";
  writeLogFile(channel, level, message, { agentId: options.agentId, ...(options.data ?? {}) });
  try {
    await db.insert(systemLog).values({
      channel,
      level,
      taskId: options.taskId ?? null,
      message: redact(message),
      data: options.data ?? null,
    });
  } catch {
    /* DB logging is best-effort; the file log remains authoritative */
  }
}

export function tailLog(channel: string, maxLines = 200): string[] {
  try {
    const file = path.join(roots().logsRoot, `${channel}.log`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").trim().split("\n").slice(-maxLines);
  } catch {
    return [];
  }
}
