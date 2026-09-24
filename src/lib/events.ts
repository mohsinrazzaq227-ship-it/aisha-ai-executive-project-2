import { EventEmitter } from "node:events";
import { and, asc, gt, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentStates, events } from "@/db/schema";
import { writeLogFile } from "@/lib/logging";

/** Authoritative event vocabulary. The 3D office, panels and log all consume this. */
export const EVENT_TYPES = [
  "TASK_CREATED",
  "TASK_PLANNED",
  "TASK_STATUS",
  "APPROVAL_REQUESTED",
  "APPROVAL_GRANTED",
  "APPROVAL_DENIED",
  "APPROVAL_INVALIDATED",
  "AGENT_ASSIGNED",
  "AGENT_STATE",
  "AGENT_WALKING",
  "AGENT_WORKING",
  "AGENT_SPEAKING",
  "AGENT_HANDOFF",
  "AGENT_RECEIVING",
  "AGENT_COMPLETED",
  "AGENT_ERROR",
  "TOOL_STARTED",
  "TOOL_PROGRESS",
  "TOOL_COMPLETED",
  "TOOL_FAILED",
  "ARTIFACT_CREATED",
  "VIDEO_RENDER_PROGRESS",
  "VIDEO_VALIDATED",
  "USER_MESSAGE",
  "SUPERVISOR_MESSAGE",
  "SECURITY",
  "SYSTEM",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type AgentState =
  | "IDLE"
  | "LISTENING"
  | "PLANNING"
  | "WALKING"
  | "WORKING"
  | "WAITING_APPROVAL"
  | "HANDOFF"
  | "RECEIVING"
  | "SPEAKING"
  | "COMPLETED"
  | "ERROR";

export type ExecutiveEvent = {
  id?: number;
  ts: string;
  taskId?: string | null;
  runId?: string | null;
  agentId?: string | null;
  type: EventType;
  message: string;
  data?: Record<string, unknown>;
  severity?: "info" | "warn" | "error" | "success";
};

type Bus = { emitter: EventEmitter };
const globalForBus = globalThis as typeof globalThis & { __aiExecBus?: Bus };
const bus: Bus = globalForBus.__aiExecBus ?? { emitter: new EventEmitter() };
bus.emitter.setMaxListeners(200);
globalForBus.__aiExecBus = bus;

export function subscribe(listener: (event: ExecutiveEvent) => void): () => void {
  bus.emitter.on("event", listener);
  return () => bus.emitter.off("event", listener);
}

function notify(event: ExecutiveEvent): void {
  try {
    bus.emitter.emit("event", event);
  } catch {
    /* never break a task because a subscriber failed */
  }
}

export async function emit(event: ExecutiveEvent): Promise<ExecutiveEvent> {
  const timestamp = event.ts ?? new Date().toISOString();
  const record: ExecutiveEvent = { ...event, ts: timestamp };
  try {
    const [row] = await db
      .insert(events)
      .values({
        ts: new Date(timestamp),
        taskId: event.taskId ?? null,
        runId: event.runId ?? null,
        agentId: event.agentId ?? null,
        type: event.type,
        message: event.message,
        data: (event.data ?? null) as Record<string, unknown> | null,
        severity: event.severity ?? "info",
      })
      .returning({ id: events.id });
    record.id = row?.id;
  } catch (error) {
    writeLogFile("errors", "error", `event persist failed: ${(error as Error).message}`, event);
  }
  writeLogFile(severityChannel(event), event.severity === "error" ? "error" : "info", `[${event.type}] ${event.message}`, {
    taskId: event.taskId,
    agentId: event.agentId,
    data: event.data,
  });
  notify(record);
  return record;
}

function severityChannel(event: ExecutiveEvent): "supervisor" | "agents" | "security" | "media" | "browser" | "computer" {
  if (event.type.startsWith("APPROVAL") || event.type === "SECURITY") return "security";
  if (event.type === "VIDEO_RENDER_PROGRESS" || event.type === "VIDEO_VALIDATED") return "media";
  if (event.agentId?.includes("browser") || event.agentId?.includes("research")) return "browser";
  if (event.agentId?.includes("computer")) return "computer";
  if (event.type.startsWith("AGENT")) return "agents";
  return "supervisor";
}

/** Update the durable agent state row and emit the matching event atomically-ish. */
export async function setAgentState(
  agentId: string,
  state: AgentState,
  options: {
    taskId?: string | null;
    stepId?: string | null;
    stationId?: string;
    message?: string;
    mood?: string;
    data?: Record<string, unknown>;
    emitEvent?: boolean;
  } = {},
): Promise<void> {
  const explicit: Partial<Record<AgentState, EventType>> = {
    IDLE: "AGENT_STATE",
    LISTENING: "AGENT_STATE",
    PLANNING: "AGENT_STATE",
    WALKING: "AGENT_WALKING",
    WORKING: "AGENT_WORKING",
    WAITING_APPROVAL: "AGENT_STATE",
    HANDOFF: "AGENT_HANDOFF",
    RECEIVING: "AGENT_RECEIVING",
    SPEAKING: "AGENT_SPEAKING",
    COMPLETED: "AGENT_COMPLETED",
    ERROR: "AGENT_ERROR",
  };
  try {
    await db
      .insert(agentStates)
      .values({
        agentId,
        state,
        taskId: options.taskId ?? null,
        stepId: options.stepId ?? null,
        stationId: options.stationId ?? "HOT_DESK",
        lastMessage: options.message ?? null,
        mood: options.mood ?? "CALM",
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: agentStates.agentId,
        set: {
          state,
          taskId: options.taskId ?? null,
          stepId: options.stepId ?? null,
          lastMessage: options.message ?? null,
          mood: options.mood ?? "CALM",
          updatedAt: new Date(),
          ...(options.stationId ? { stationId: options.stationId } : {}),
        },
      });
  } catch (error) {
    writeLogFile("errors", "error", `agent state persist failed: ${(error as Error).message}`, { agentId, state });
  }
  if (options.emitEvent === false) return;
  await emit({
    ts: new Date().toISOString(),
    taskId: options.taskId ?? null,
    agentId,
    type: explicit[state] ?? "AGENT_STATE",
    message: options.message ?? `${agentId} -> ${state}`,
    severity: state === "ERROR" ? "error" : state === "COMPLETED" ? "success" : "info",
    data: { state, stationId: options.stationId, mood: options.mood, ...(options.data ?? {}) },
  });
}

export async function eventsSince(sinceId: number, limit = 200, taskId?: string): Promise<ExecutiveEvent[]> {
  const rows = await db
    .select()
    .from(events)
    .where(taskId ? and(gt(events.id, sinceId), eq(events.taskId, taskId)) : gt(events.id, sinceId))
    .orderBy(asc(events.id))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    ts: row.ts.toISOString(),
    taskId: row.taskId,
    runId: row.runId,
    agentId: row.agentId,
    type: row.type as EventType,
    message: row.message,
    data: (row.data ?? undefined) as Record<string, unknown> | undefined,
    severity: row.severity as ExecutiveEvent["severity"],
  }));
}

export async function latestEventId(): Promise<number> {
  const [row] = await db.select({ max: sql<number>`coalesce(max(${events.id}), 0)` }).from(events);
  return Number(row?.max ?? 0);
}
