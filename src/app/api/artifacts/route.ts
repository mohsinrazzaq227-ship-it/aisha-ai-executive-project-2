import { promises as fs } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { artifacts } from "@/db/schema";
import { listArtifacts } from "@/lib/artifacts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return Response.json({ artifacts: await listArtifacts(200) });
  }
  const [row] = await db.select().from(artifacts).where(eq(artifacts.id, id));
  if (!row) return Response.json({ error: `artifact ${id} not found` }, { status: 404 });
  const buffer = await fs.readFile(row.path).catch(() => null);
  if (!buffer) return Response.json({ error: `artifact file missing on disk: ${row.path}` }, { status: 410 });
  return new Response(new Uint8Array(buffer), {
    headers: {
      "content-type": row.mimeType,
      "content-disposition": `inline; filename="${row.name.replace(/"/g, "")}"`,
      "x-artifact-sha256": row.sha256,
      "x-artifact-bytes": String(row.bytes),
      "x-artifact-origin": row.origin,
    },
  });
}
