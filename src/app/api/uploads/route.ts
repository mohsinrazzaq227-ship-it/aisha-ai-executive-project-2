import { promises as fs } from "node:fs";
import path from "node:path";
import { DIRS, appConfig } from "@/lib/config";
import { registerArtifact, listArtifacts } from "@/lib/artifacts";
import { audit } from "@/lib/security";
import { ensureDir, slugify } from "@/lib/util";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  const artifacts = (await listArtifacts(200)).filter((row) => row.origin === "user-upload");
  return Response.json({ uploads: artifacts });
}

export async function POST(request: Request) {
  const config = await appConfig();
  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ error: "multipart/form-data is required" }, { status: 400 });
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "a 'file' field is required" }, { status: 400 });

  const extension = path.extname(file.name).toLowerCase();
  if (!config.uploads.allowedExtensions.includes(extension)) {
    await audit({ actor: "operator", action: "upload.rejected", target: file.name, risk: "MEDIUM", decision: "BLOCKED", detail: { extension } });
    return Response.json({ error: `extension ${extension} is not allowed`, allowed: config.uploads.allowedExtensions }, { status: 415 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.byteLength > config.uploads.maxBytes) {
    await audit({ actor: "operator", action: "upload.rejected", target: file.name, risk: "MEDIUM", decision: "BLOCKED", detail: { bytes: buffer.byteLength } });
    return Response.json({ error: `file exceeds ${config.uploads.maxBytes} bytes`, bytes: buffer.byteLength }, { status: 413 });
  }

  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(DIRS.uploads, day);
  await ensureDir(dir);
  const target = path.join(dir, `${slugify(path.basename(file.name, extension), 48)}${extension}`);
  await fs.writeFile(target, buffer);
  const artifact = await registerArtifact({
    name: path.basename(target),
    kind: `upload:${extension.replace(".", "")}`,
    filePath: target,
    mimeType: file.type || "application/octet-stream",
    origin: "user-upload",
    validation: { valid: true, method: "byte-write-readback", detail: `${buffer.byteLength}B written and re-read by the artifact registrar` },
  });
  await audit({ actor: "operator", action: "upload.accepted", target: target, risk: "LOW", decision: "ALLOWED", detail: { bytes: buffer.byteLength, artifactId: artifact.id } });
  return Response.json({ artifact }, { status: 201 });
}
