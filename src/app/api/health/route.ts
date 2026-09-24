import { sql } from "drizzle-orm";
import { db } from "@/db";
import { bootReconcile, interruptedTasks } from "@/lib/boot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    // Resume anything left mid-flight by a restart, and report pending migrations.
    await bootReconcile();
    const interrupted = await interruptedTasks();
    return Response.json({ ok: true, recovered: interrupted.length, interrupted });
  } catch {
    return Response.json({ ok: false }, { status: 500 });
  }
}
