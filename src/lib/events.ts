/**
 * ONE authoritative event stream.
 *
 * Every subsystem writes here and only here: the task engine, the tool layer,
 * the approval gate, the resource governor and the 3D office all consume the
 * same rows. There is no second event bus and no UI-only event simulation.
 *
 * Topics follow the merged Project 1 / Project 2 vocabulary:
 *  task.*, step.*, agent.*, agent.walk.*, handoff.*, tool.*, approval.*,
 *  verification.*, artifact.*, resource.*, security.*, system.*
 */
import { desc, gt, sql } from "drizzle-orm";
import { db } from "@/db";
import { events, type EventRow } from "@/db/schema";
import { redactSecrets } from "@/lib/util";

export type EmitInput = {
  topic: string;
  message: string;
  taskId?: string | null;
  stepId?: string | null;
  agentId?: string | null;
  level?: "info" | "warn" | "error" | "success";
  payload?: Record<string, unknown>;
};

const topicListeners = new Set<(row: EventRow) => void>();

export function subscribe(listener: (row: EventRow) => void): () => void {
  topicListeners.add(listener);
  return () => topicListeners.delete(listener);
}

export async function emit(input: EmitInput): Promise<EventRow> {
  const row = {
    topic: input.topic,
    message: redactSecrets(input.message).slice(0, 4000),
    taskId: input.taskId ?? null,
    stepId: input.stepId ?? null,
    agentId: input.agentId ?? null,
    level: input.level ?? "info",
    payload: (input.payload ?? {}) as Record<string, unknown>,
  };
  const [inserted] = await db.insert(events).values(row).returning();
  for (const listener of topicListeners) {
    try {
      listener(inserted);
    } catch {
      // a broken listener must never break the engine
    }
  }
  return inserted;
}

/** Fire-and-forget variant for hot paths that must not await the DB. */
export function emitSoon(input: EmitInput): void {
  void emit(input).catch(() => undefined);
}

export async function recentEvents(limit = 200): Promise<EventRow[]> {
  return db.select().from(events).orderBy(desc(events.id)).limit(Math.min(1000, Math.max(1, limit)));
}

export async function eventsAfter(lastId: number, limit = 200): Promise<EventRow[]> {
  return db
    .select()
    .from(events)
    .where(gt(events.id, lastId))
    .orderBy(events.id)
    .limit(Math.min(500, Math.max(1, limit)));
}

export async function eventCount(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(events);
  return row?.count ?? 0;
}
