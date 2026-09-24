import { promises as fs } from "node:fs";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { artifacts, type ArtifactRow } from "@/db/schema";
import { DIRS } from "@/lib/config";
import { emit } from "@/lib/events";
import { ensureDir, newId, sha256, toRelative } from "@/lib/util";

export type RegisterInput = {
  name: string;
  kind: string;
  filePath: string;
  mimeType: string;
  origin?: "deterministic" | "ai-generated" | "retrieved" | "user-upload";
  taskId?: string | null;
  stepId?: string | null;
  agentId?: string | null;
  validation?: { valid: boolean; method: string; detail: string };
};

/**
 * Registers a real file on disk as an artifact. Refuses to register a missing
 * or empty file: an artifact row is evidence, not decoration.
 */
export async function registerArtifact(input: RegisterInput): Promise<ArtifactRow> {
  const absolute = path.resolve(input.filePath);
  const buffer = await fs.readFile(absolute).catch(() => null);
  if (!buffer) {
    throw new Error(`artifact file does not exist: ${absolute}`);
  }
  if (buffer.byteLength === 0) {
    throw new Error(`artifact file is empty: ${absolute}`);
  }
  const digest = sha256(buffer);
  const validation = input.validation ?? {
    valid: true,
    method: "byte-read",
    detail: `${buffer.byteLength} bytes read back from disk; sha256 ${digest.slice(0, 12)}`,
  };
  const [row] = await db
    .insert(artifacts)
    .values({
      id: newId("art"),
      taskId: input.taskId ?? null,
      stepId: input.stepId ?? null,
      agentId: input.agentId ?? null,
      name: input.name,
      kind: input.kind,
      path: absolute,
      mimeType: input.mimeType,
      bytes: buffer.byteLength,
      sha256: digest,
      origin: input.origin ?? "deterministic",
      validation,
    })
    .returning();
  await emit({
    topic: "artifact.created",
    taskId: input.taskId ?? null,
    stepId: input.stepId ?? null,
    agentId: input.agentId ?? null,
    level: "success",
    message: `artifact ${row.name} (${row.kind}, ${row.bytes}B, sha256 ${digest.slice(0, 10)}…)`,
    payload: { artifactId: row.id, path: row.path, bytes: row.bytes, origin: row.origin },
  });
  return row;
}

export async function artifactDirFor(taskId: string): Promise<string> {
  const dir = path.join(DIRS.artifacts, taskId);
  await ensureDir(dir);
  return dir;
}

export async function runDirFor(taskId: string): Promise<string> {
  const dir = path.join(DIRS.runs, taskId);
  await ensureDir(dir);
  return dir;
}

export async function listArtifacts(limit = 100): Promise<ArtifactRow[]> {
  return db.select().from(artifacts).orderBy(desc(artifacts.createdAt)).limit(Math.min(500, Math.max(1, limit)));
}

export async function artifactsForTask(taskId: string): Promise<ArtifactRow[]> {
  return db.select().from(artifacts).where(eq(artifacts.taskId, taskId)).orderBy(desc(artifacts.createdAt));
}

export function relativeArtifactPath(filePath: string): string {
  return toRelative(DIRS.root, filePath);
}
