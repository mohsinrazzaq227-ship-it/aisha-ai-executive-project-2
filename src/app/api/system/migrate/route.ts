import { migrationStatus, runMigrations } from "@/lib/migrations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Explicit migrations only — never triggered automatically by startup. */
export async function GET() {
  const status = await migrationStatus();
  return Response.json({ ok: true, ...status });
}

export async function POST() {
  const result = await runMigrations();
  return Response.json({ ok: result.failed.length === 0, ...result }, { status: result.failed.length === 0 ? 200 : 500 });
}
