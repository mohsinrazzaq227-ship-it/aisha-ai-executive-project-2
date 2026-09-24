import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
}

/** Deterministic canonical JSON: sorted keys, stable for hashing. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map(walk);
    const obj = input as Record<string, unknown>;
    if (seen.has(obj)) return "[circular]";
    seen.add(obj);
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        if (obj[key] !== undefined) acc[key] = walk(obj[key]);
        return acc;
      }, {});
  };
  return JSON.stringify(walk(value));
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function parametersHash(action: unknown): string {
  return sha256(canonicalJson(action));
}

export function issueApprovalToken(parametersHashValue: string, approvalId: string, secret: string): string {
  return sha256(`${approvalId}:${parametersHashValue}:${secret}`);
}

export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function slugify(input: string, max = 48): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return slug.length > 0 ? slug : "untitled";
}
