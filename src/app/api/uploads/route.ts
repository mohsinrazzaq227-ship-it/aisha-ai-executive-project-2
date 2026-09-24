import fs from "node:fs";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { uploads } from "@/db/schema";
import { emit } from "@/lib/events";
import { newId, sha256 } from "@/lib/ids";
import { logEvent } from "@/lib/logging";
import { ensureDir, humanSize, relToRoot, safeFilename, uniqueFilename, roots } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 100 * 1024 * 1024;
const ALLOWED_MIME = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "video/mp4",
  "video/quicktime",
  "video/webm",
];
const ALLOWED_EXT = [".pdf", ".txt", ".md", ".csv", ".json", ".html", ".docx", ".xlsx", ".xls", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp3", ".wav", ".m4a", ".mp4", ".mov", ".webm"];

export async function GET() {
  const rows = await db.select().from(uploads).orderBy(desc(uploads.createdAt)).limit(60);
  return Response.json({
    ok: true,
    uploads: rows.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      originalName: row.originalName,
      safeName: row.safeName,
      relPath: row.relPath,
      mime: row.mime,
      size: row.size,
      sizeHuman: humanSize(row.size),
      sha256: row.sha256,
      status: row.status,
      extraction: row.extraction,
      createdAt: row.createdAt,
      exists: fs.existsSync(path.join(roots().projectRoot, row.relPath)),
    })),
    limits: { maxBytes: MAX_BYTES, allowedMime: ALLOWED_MIME, allowedExtensions: ALLOWED_EXT },
  });
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ ok: false, error: "Expected a multipart/form-data upload." }, { status: 400 });
  }
  const files = form.getAll("file").filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) return Response.json({ ok: false, error: "No file received (field name must be 'file')." }, { status: 400 });

  const stored: Record<string, unknown>[] = [];
  const rejected: { name: string; reason: string }[] = [];
  for (const file of files) {
    const ext = path.extname(file.name).toLowerCase();
    if (file.size === 0) {
      rejected.push({ name: file.name, reason: "Empty file" });
      continue;
    }
    if (file.size > MAX_BYTES) {
      rejected.push({ name: file.name, reason: `Larger than the ${humanSize(MAX_BYTES)} limit` });
      continue;
    }
    const mimeOk = ALLOWED_MIME.includes(file.type) || ALLOWED_EXT.includes(ext);
    if (!mimeOk) {
      rejected.push({ name: file.name, reason: `Unsupported type "${file.type || ext}". Allowed: ${ALLOWED_EXT.join(", ")}` });
      continue;
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const dir = ensureDir(path.join(roots().uploadsRoot, new Date().toISOString().slice(0, 10)));
    const safeName = uniqueFilename(dir, safeFilename(file.name));
    const finalPath = path.join(dir, safeName);
    // Stream to a temp file, then publish atomically: a cancelled upload leaves no half file.
    const tempPath = `${finalPath}.partial`;
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, finalPath);
    const id = newId("upl");
    const hash = sha256(buffer);
    await db.insert(uploads).values({
      id,
      originalName: file.name,
      safeName,
      relPath: relToRoot(finalPath),
      mime: file.type || "application/octet-stream",
      size: buffer.byteLength,
      sha256: hash,
      status: "RECEIVED",
      extraction: null,
    });
    await logEvent("uploads", `Upload stored: ${safeName} (${humanSize(buffer.byteLength)})`, { data: { id, sha256: hash, mime: file.type } });
    await emit({
      ts: new Date().toISOString(),
      type: "ARTIFACT_CREATED",
      agentId: "asset_manager",
      message: `Upload received and verified on the backend: ${safeName}`,
      severity: "success",
      data: { uploadId: id, name: safeName, size: buffer.byteLength, mime: file.type, sha256: hash, storedAt: finalPath },
    });
    stored.push({ id, originalName: file.name, safeName, absPath: finalPath, mime: file.type, size: buffer.byteLength, sha256: hash, status: "RECEIVED" });
  }

  return Response.json(
    { ok: stored.length > 0, stored, rejected, backendConfirmed: true },
    { status: stored.length > 0 ? 200 : 415 },
  );
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return Response.json({ ok: false, error: "id query parameter required." }, { status: 400 });
  const [row] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
  if (!row) return Response.json({ ok: false, error: "Upload not found." }, { status: 404 });
  const full = path.join(roots().projectRoot, row.relPath);
  let removed = false;
  if (fs.existsSync(full)) {
    fs.unlinkSync(full);
    removed = true;
  }
  await db.delete(uploads).where(eq(uploads.id, id));
  await logEvent("uploads", `Upload removed: ${row.safeName} (file deleted: ${removed})`, { level: "warn", data: { id } });
  return Response.json({ ok: true, removed, id });
}
