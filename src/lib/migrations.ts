/**
 * Versioned, checksummed, repeatable migration runner (Project 2 architecture).
 *
 * Behaviour:
 *  * reads migrations/*.sql in filename order
 *  * records version + sha256 checksum + duration in schema_migrations
 *  * refuses to run a file whose checksum changed after it was applied
 *  * applies each file inside a transaction, so a failure rolls back
 *  * is safe to call on every boot: already-applied files are skipped
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { pool } from "@/db";
import { DIRS } from "@/lib/config";
import { errorMessage, sha256 } from "@/lib/util";

export type MigrationResult = { version: string; status: "APPLIED" | "SKIPPED" | "CHANGED" | "FAILED"; ms: number; detail: string };

export async function runMigrations(): Promise<{ results: MigrationResult[]; ok: boolean }> {
  const dir = DIRS.migrations;
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
  } catch {
    return { results: [], ok: true };
  }

  await pool.query(`create table if not exists schema_migrations (
    version text primary key,
    checksum text not null,
    applied_at timestamptz not null default now(),
    duration_ms integer not null default 0
  )`);

  const results: MigrationResult[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const sql = await fs.readFile(path.join(dir, file), "utf8");
    const checksum = sha256(sql);
    const existing = await pool.query<{ checksum: string }>("select checksum from schema_migrations where version = $1", [version]);
    if (existing.rows.length) {
      const status = existing.rows[0].checksum === checksum ? "SKIPPED" : "CHANGED";
      results.push({
        version,
        status,
        ms: 0,
        detail: status === "SKIPPED" ? "already applied with an identical checksum" : "checksum changed since it was applied — refusing to re-run automatically",
      });
      continue;
    }
    const started = Date.now();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations (version, checksum, duration_ms) values ($1, $2, $3)", [version, checksum, Date.now() - started]);
      await client.query("commit");
      results.push({ version, status: "APPLIED", ms: Date.now() - started, detail: "applied inside a transaction" });
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      results.push({ version, status: "FAILED", ms: Date.now() - started, detail: errorMessage(error) });
    } finally {
      client.release();
    }
  }
  return { results, ok: results.every((result) => result.status !== "FAILED" && result.status !== "CHANGED") };
}
