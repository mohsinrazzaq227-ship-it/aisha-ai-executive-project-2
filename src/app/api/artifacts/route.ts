import fs from "node:fs";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { artifacts } from "@/db/schema";
import { assertInside, humanSize, roots } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const downloadId = url.searchParams.get("download");
  const r = roots();

  if (downloadId) {
    const [row] = await db.select().from(artifacts).where(eq(artifacts.id, downloadId)).limit(1);
    if (!row) return Response.json({ ok: false, error: "Artifact not found." }, { status: 404 });
    const absPath = ((row.meta ?? {}) as { absPath?: string }).absPath ?? path.join(r.projectRoot, row.relPath);
    let resolved: string;
    try {
      // Every artifact is served only from inside the application area.
      resolved = assertInside(r.projectRoot, absPath);
    } catch {
      return Response.json({ ok: false, error: "Artifact path is outside the permitted area and will not be served." }, { status: 403 });
    }
    if (!fs.existsSync(resolved)) return Response.json({ ok: false, error: `File no longer exists on disk: ${resolved}` }, { status: 410 });
    if (fs.statSync(resolved).isDirectory()) return Response.json({ ok: false, error: "Artifact is a directory." }, { status: 400 });
    const buffer = fs.readFileSync(resolved);
    const forceDownload = url.searchParams.has("attachment");
    const inlineable = /^(image\/|video\/|audio\/|text\/|application\/json|application\/pdf)/.test(row.mime) && !forceDownload;
    return new Response(new Uint8Array(buffer), {
      headers: {
        "content-type": row.mime,
        "content-length": String(buffer.byteLength),
        "content-disposition": `${inlineable ? "inline" : "attachment"}; filename="${row.name.replace(/"/g, "")}"`,
        "cache-control": "no-store",
      },
    });
  }

  const taskId = url.searchParams.get("taskId");
  const rows = taskId
    ? await db.select().from(artifacts).where(eq(artifacts.taskId, taskId)).orderBy(desc(artifacts.createdAt))
    : await db.select().from(artifacts).orderBy(desc(artifacts.createdAt)).limit(80);

  return Response.json({
    ok: true,
    artifacts: rows.map((row) => {
      const absPath = ((row.meta ?? {}) as { absPath?: string }).absPath ?? path.join(r.projectRoot, row.relPath);
      return {
        id: row.id,
        taskId: row.taskId,
        stepId: row.stepId,
        agentId: row.agentId,
        kind: row.kind,
        name: row.name,
        relPath: row.relPath,
        absPath,
        mime: row.mime,
        size: row.size,
        sizeHuman: humanSize(row.size),
        validated: row.validated,
        meta: row.meta,
        createdAt: row.createdAt,
        exists: fs.existsSync(absPath),
        downloadUrl: `/api/artifacts?download=${row.id}`,
      };
    }),
  });
}
