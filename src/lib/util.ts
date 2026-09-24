import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function approvalSecret(): string {
  const fromEnv = process.env.AISHA_APPROVAL_SECRET;
  if (fromEnv && fromEnv.length >= 8) return fromEnv;
  // Derived from the install path so approvals cannot be forged across installs.
  return sha256(`aisha:${process.cwd()}`);
}

/** Hash of the exact action, used to invalidate approvals if parameters change. */
export function hashAction(input: { action: string; target: string; params: unknown }): string {
  return sha256(
    `${input.action}\u0000${input.target}\u0000${stableStringify(input.params)}\u0000${approvalSecret()}`,
  );
}

export function makeApprovalToken(): string {
  return randomBytes(18).toString("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function slugify(text: string, max = 48): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return base || "item";
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function redactSecrets(text: string): string {
  return text
    .replace(/(\/\/[^\s:/@]+:)[^@\s/]+(@)/g, "$1***$2")
    .replace(/(password|passwd|token|secret|apikey|api_key)\s*[:=]\s*[^\s,;"']+/gi, "$1=***");
}

export function truncate(text: string, max = 4000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

export async function ensureDir(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function fileInfo(file: string): Promise<{ bytes: number; sha256: string; mtime: string }> {
  const buf = await fs.readFile(file);
  const stat = await fs.stat(file);
  return { bytes: buf.byteLength, sha256: sha256(buf), mtime: stat.mtime.toISOString() };
}

export function toRelative(root: string, target: string): string {
  const rel = path.relative(root, target);
  return rel.startsWith("..") ? target : rel;
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

export function bytesToMb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}
