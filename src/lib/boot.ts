import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { planSteps, tasks } from "@/db/schema";
import { emit } from "@/lib/events";
import { logEvent } from "@/lib/logging";
import { migrationStatus } from "@/lib/migrations";
import { resumeTask, runningTasks } from "@/lib/supervisor";

/**
 * Boot reconciliation.
 *
 * A task lives in two places: durable rows in PostgreSQL and an in-process
 * scheduler. If the backend is restarted mid-task (crash, update, machine
 * reboot), the rows survive but nothing is driving them. This hook detects that
 * honestly, marks the interruption in the event stream, and resumes the work
 * from the first incomplete node instead of leaving a zombie "RUNNING" task.
 *
 * It also reports pending migrations at startup WITHOUT applying them (schema
 * changes are always an explicit user action: `node scripts/migrate.mjs`).
 */
const globalForBoot = globalThis as typeof globalThis & { __aishaBootDone?: Promise<void> };

export function bootReconcile(): Promise<void> {
  if (!globalForBoot.__aishaBootDone) {
    globalForBoot.__aishaBootDone = (async () => {
      try {
        const stuck = await db.select().from(tasks).where(inArray(tasks.status, ["RUNNING", "QUEUED", "PLANNING"]));
        const alreadyRunning = new Set(runningTasks().map((entry) => entry.taskId));
        for (const task of stuck) {
          if (alreadyRunning.has(task.id)) continue;
          await db.update(tasks).set({ status: "QUEUED", updatedAt: new Date() }).where(inArray(tasks.id, [task.id]));
          await emit({
            ts: new Date().toISOString(),
            taskId: task.id,
            runId: task.runId,
            agentId: "master_supervisor",
            type: "TASK_STATUS",
            message: `Recovered after a backend restart: resuming "${task.title}" from its first incomplete step. Any step that was mid-flight is re-verified, not assumed to have succeeded.`,
            severity: "warn",
            data: { recovery: true },
          });
          void resumeTask(task.id);
        }
        if (stuck.length > 0) await logEvent("supervisor", `Boot recovery resumed ${stuck.length} interrupted task(s).`, { level: "warn" });
        const status = await migrationStatus();
        if (status.pending.length > 0) {
          await logEvent("system", `Pending migrations detected at startup (NOT applied automatically): ${status.pending.join(", ")}. Run: node scripts/migrate.mjs`, { level: "warn" });
        }
      } catch (error) {
        await logEvent("errors", `Boot reconciliation failed: ${(error as Error).message}`, { level: "error" });
      }
    })();
  }
  return globalForBoot.__aishaBootDone;
}

export async function interruptedTasks(): Promise<{ id: string; title: string; status: string }[]> {
  const rows = await db.select().from(tasks).where(inArray(tasks.status, ["RUNNING", "QUEUED", "PLANNING"]));
  const active = new Set(runningTasks().map((entry) => entry.taskId));
  return rows.filter((row) => !active.has(row.id)).map((row) => ({ id: row.id, title: row.title, status: row.status }));
}

export { planSteps };
