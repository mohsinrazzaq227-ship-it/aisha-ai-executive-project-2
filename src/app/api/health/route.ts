import { sql } from "drizzle-orm";
import { db } from "@/db";
import { ensureBoot } from "@/lib/supervisor";
import { listTools } from "@/lib/tools";
import { runMigrations } from "@/lib/migrations";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  try {
    const result = await db.execute(sql`select version() as version`);
    const rows = result.rows as Array<{ version: string }>;
    checks.database = { ok: true, detail: (rows[0]?.version ?? "unknown").split(" ").slice(0, 2).join(" ") };
  } catch (error) {
    checks.database = { ok: false, detail: String(error).slice(0, 200) };
  }

  try {
    const migrations = await runMigrations();
    checks.migrations = { ok: migrations.ok, detail: `${migrations.results.length} migration file(s); ${migrations.results.map((r) => `${r.version}:${r.status}`).join(", ") || "none present"}` };
  } catch (error) {
    checks.migrations = { ok: false, detail: String(error).slice(0, 200) };
  }

  try {
    await ensureBoot();
    checks.supervisor = { ok: true, detail: "agents seeded, stale-task recovery reconciled" };
  } catch (error) {
    checks.supervisor = { ok: false, detail: String(error).slice(0, 200) };
  }

  const tools = listTools();
  checks.tools = { ok: tools.length > 0, detail: `${tools.length} registered tools` };

  const ok = Object.values(checks).every((check) => check.ok);
  return Response.json(
    {
      status: ok ? "ok" : "degraded",
      service: "AISHA",
      version: "1.0.0",
      ms: Date.now() - started,
      checks,
    },
    { status: ok ? 200 : 503 },
  );
}
