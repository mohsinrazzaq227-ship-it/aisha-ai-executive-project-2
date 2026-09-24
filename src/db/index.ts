import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
    // Durable task state shares this pool with the SSE event stream and every task
    // runner. Without a bound, a saturated pool makes a step wait forever with no
    // error (observed as a step stuck in RUNNING). Bounded pool + acquire timeout
    // turns that into an explicit, reportable failure instead of a silent hang.
    max: Number(process.env.DATABASE_POOL_MAX ?? 24),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: Number(process.env.DATABASE_ACQUIRE_TIMEOUT_MS ?? 10000),
    statement_timeout: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? 120000),
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool);
