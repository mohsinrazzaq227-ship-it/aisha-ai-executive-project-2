import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { logEvent, writeLogFile } from "@/lib/logging";
import { roots } from "@/lib/workspace";
import { sha256 } from "@/lib/ids";

/**
 * Explicit, versioned, recoverable migrations.
 *
 * Rules (deliberate, per the operating manual):
 *   * Startup never runs a destructive schema operation. `drizzle-kit push --force`
 *     is NOT part of the launch path.
 *   * Each file in migrations/ is applied once, inside its own transaction, and
 *     recorded with a checksum in schema_migrations.
 *   * A checksum mismatch means the file changed after being applied: that is
 *     reported as a failure instead of silently re-applying.
 *   * Every migration is written to be idempotent (IF NOT EXISTS / ADD COLUMN IF
 *     NOT EXISTS) so a partially applied installation can be repaired safely.
 */

export type MigrationRecord = { version: string; checksum: string; appliedAt: string | null; durationMs: number };
export type MigrationRunResult = {
  applied: { version: string; durationMs: number }[];
  skipped: string[];
  failed: { version: string; error: string }[];
  pending: string[];
  checksumMismatches: string[];
};

function migrationsDir(): string {
  return path.join(roots().projectRoot, "migrations");
}

export function listMigrationFiles(): { version: string; file: string; sqlText: string; checksum: string }[] {
  const dir = migrationsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sqlText = fs.readFileSync(path.join(dir, name), "utf8");
      return { version: name, file: path.join(dir, name), sqlText, checksum: sha256(sqlText) };
    });
}

async function ensureMigrationsTable(): Promise<void> {
  await db.execute(sql`
    create table if not exists schema_migrations (
      version text primary key,
      checksum text not null,
      applied_at timestamptz not null default now(),
      duration_ms integer not null default 0
    )`);
}

export async function appliedMigrations(): Promise<Map<string, MigrationRecord>> {
  await ensureMigrationsTable();
  const result = await db.execute(sql`select version, checksum, applied_at, duration_ms from schema_migrations order by version`);
  const rows = (result as unknown as { rows?: { version: string; checksum: string; applied_at: string; duration_ms: number }[] }).rows ?? [];
  return new Map(
    rows.map((row) => [row.version, { version: row.version, checksum: row.checksum, appliedAt: row.applied_at, durationMs: row.duration_ms }]),
  );
}

export async function migrationStatus(): Promise<{ records: MigrationRecord[]; pending: string[]; checksumMismatches: string[] }> {
  const applied = await appliedMigrations();
  const files = listMigrationFiles();
  const pending = files.filter((file) => !applied.has(file.version)).map((file) => file.version);
  const checksumMismatches = files
    .filter((file) => applied.has(file.version) && applied.get(file.version)?.checksum !== file.checksum)
    .map((file) => file.version);
  return { records: Array.from(applied.values()), pending, checksumMismatches };
}

export async function runMigrations(options: { log?: boolean } = {}): Promise<MigrationRunResult> {
  const result: MigrationRunResult = { applied: [], skipped: [], failed: [], pending: [], checksumMismatches: [] };
  const applied = await appliedMigrations();
  const files = listMigrationFiles();
  if (files.length === 0) {
    result.failed.push({ version: "none", error: `No migration files found in ${migrationsDir()}` });
    return result;
  }
  // Baseline: on installations created before the migration ledger existed, 001_core.sql
  // describes objects that are already present (created by drizzle-kit push). Record the
  // baseline rather than re-running colliding DDL.
  const first = files[0];
  if (first && !applied.has(first.version) && first.version === "001_core.sql") {
    const probe = await db.execute(sql`select to_regclass('public.tasks') is not null as exists_flag`);
    const exists = Boolean(((probe as unknown as { rows?: { exists_flag: boolean }[] }).rows ?? [])[0]?.exists_flag);
    if (exists) {
      await db.execute(sql`insert into schema_migrations (version, checksum, duration_ms) values (${first.version}, ${first.checksum}, 0) on conflict (version) do nothing`);
      applied.set(first.version, { version: first.version, checksum: first.checksum, appliedAt: new Date().toISOString(), durationMs: 0 });
      writeLogFile("system", "info", `Baselined ${first.version}: its objects already existed, DDL was not re-run.`);
    }
  }

  for (const file of files) {
    const existing = applied.get(file.version);
    if (existing && existing.checksum !== file.checksum) {
      result.checksumMismatches.push(file.version);
      const message = `Migration ${file.version} was already applied but its content changed (checksum mismatch). Refusing to re-apply; review it manually.`;
      writeLogFile("errors", "error", message);
      if (options.log !== false) await logEvent("system", message, { level: "error" });
      continue;
    }
    if (existing) {
      result.skipped.push(file.version);
      continue;
    }
    const started = Date.now();
    try {
      // Each migration runs in its own transaction: a failure cannot leave a half state.
      await db.execute(sql.raw("begin"));
      await db.execute(sql.raw(file.sqlText));
      const duration = Date.now() - started;
      await db.execute(sql`insert into schema_migrations (version, checksum, duration_ms) values (${file.version}, ${file.checksum}, ${duration})`);
      await db.execute(sql.raw("commit"));
      result.applied.push({ version: file.version, durationMs: duration });
      if (options.log !== false) await logEvent("system", `Migration applied: ${file.version} (${duration} ms)`);
    } catch (error) {
      try {
        await db.execute(sql.raw("rollback"));
      } catch {
        /* connection may already be clean */
      }
      const message = (error as Error).message;
      result.failed.push({ version: file.version, error: message });
      writeLogFile("errors", "error", `Migration ${file.version} failed: ${message}`);
      if (options.log !== false) await logEvent("system", `Migration FAILED: ${file.version} — ${message}`, { level: "error" });
    }
  }
  const status = await migrationStatus();
  result.pending = status.pending;
  result.checksumMismatches = status.checksumMismatches;
  return result;
}
