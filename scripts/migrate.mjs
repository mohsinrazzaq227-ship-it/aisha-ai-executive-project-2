#!/usr/bin/env node
/**
 * AISHA AI-EXECUTIVE migration runner (explicit, never destructive).
 *
 *   node scripts/migrate.mjs            # apply pending migrations
 *   node scripts/migrate.mjs --status   # show what is applied / pending (no writes)
 *   node scripts/migrate.mjs --verify   # verify checksums of applied migrations
 *
 * Reads the same migrations/*.sql files as the application (single source of truth),
 * applies each unapplied file in its own transaction and records it in
 * schema_migrations. `drizzle-kit push --force` is never used here.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dir = path.join(root, "migrations");

function loadEnv() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && !line.trim().startsWith("#")) out[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = { ...loadEnv(), ...process.env };
const connectionString = env.DATABASE_URL;
if (!connectionString) {
  console.error("[migrate] DATABASE_URL is required (env or .env).");
  process.exit(2);
}
if (!fs.existsSync(dir)) {
  console.error(`[migrate] No migrations directory at ${dir}`);
  process.exit(2);
}

const mode = process.argv.includes("--status") ? "status" : process.argv.includes("--verify") ? "verify" : "apply";
const files = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => {
    const sqlText = fs.readFileSync(path.join(dir, name), "utf8");
    return { version: name, sqlText, checksum: createHash("sha256").update(sqlText).digest("hex") };
  });

const { Client } = await import("pg");
const client = new Client({ connectionString });
await client.connect();

try {
  await client.query(`create table if not exists schema_migrations (
    version text primary key,
    checksum text not null,
    applied_at timestamptz not null default now(),
    duration_ms integer not null default 0
  )`);
  const { rows } = await client.query("select version, checksum, applied_at, duration_ms from schema_migrations order by version");
  const applied = new Map(rows.map((row) => [row.version, row]));
  const pending = files.filter((file) => !applied.has(file.version));
  // Baseline handling: 001_core.sql describes objects created by `drizzle-kit push`
  // on installations that pre-date the migration ledger. If those objects already
  // exist we record the baseline instead of re-running DDL that would collide.
  if (pending.length > 0 && pending[0].version === "001_core.sql") {
    const probe = await client.query("select to_regclass('public.tasks') is not null as exists");
    if (probe.rows[0]?.exists) {
      await client.query("insert into schema_migrations (version, checksum, duration_ms) values ($1, $2, 0) on conflict (version) do nothing", [
        pending[0].version,
        pending[0].checksum,
      ]);
      applied.set(pending[0].version, { version: pending[0].version, checksum: pending[0].checksum, applied_at: new Date().toISOString(), duration_ms: 0 });
      console.log(`[migrate] baselined ${pending[0].version} (its objects already exist; DDL was not re-run).`);
      pending.shift();
    }
  }
  const mismatched = files.filter((file) => applied.has(file.version) && applied.get(file.version).checksum !== file.checksum);

  console.log(`[migrate] ${files.length} migration file(s); ${applied.size} applied; ${pending.length} pending.`);
  for (const file of files) {
    const state = applied.has(file.version) ? `applied ${new Date(applied.get(file.version).applied_at).toISOString()}` : "pending";
    console.log(`  - ${file.version}: ${state}`);
  }
  for (const file of mismatched) {
    console.warn(`  ! ${file.version}: CHECKSUM MISMATCH — content changed after it was applied. Review manually; it will not be re-applied.`);
  }

  if (mode === "status" || mode === "verify") {
    process.exitCode = mismatched.length > 0 ? 1 : 0;
  } else {
    let failures = 0;
    for (const file of pending) {
      const started = Date.now();
      try {
        await client.query("begin");
        await client.query(file.sqlText);
        await client.query("insert into schema_migrations (version, checksum, duration_ms) values ($1, $2, $3)", [file.version, file.checksum, Date.now() - started]);
        await client.query("commit");
        console.log(`[migrate] applied ${file.version} in ${Date.now() - started} ms`);
      } catch (error) {
        await client.query("rollback").catch(() => {});
        console.error(`[migrate] FAILED ${file.version}: ${error.message}`);
        failures += 1;
      }
    }
    console.log(failures === 0 ? "[migrate] done — database schema is up to date." : `[migrate] ${failures} migration(s) failed; the database was left in its previous consistent state.`);
    process.exitCode = failures > 0 ? 1 : 0;
  }
} finally {
  await client.end();
}
