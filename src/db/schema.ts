import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * AI-EXECUTIVE persistence layer.
 * The database is the authoritative record of every task, plan step, approval,
 * event, artifact and upload. The 3D office and every panel consume this state.
 */

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";
export type TaskStatus =
  | "QUEUED"
  | "PLANNING"
  | "RUNNING"
  | "WAITING_APPROVAL"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";
export type StepStatus =
  | "PENDING"
  | "WALKING"
  | "RUNNING"
  | "WAITING_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "SKIPPED"
  | "CANCELLED";

export type ToolInput = Record<string, unknown>;

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    title: text("title").notNull(),
    request: jsonb("request").$type<{ message: string; uploadIds?: string[] }>().notNull(),
    intent: text("intent").notNull(),
    plannerEngine: text("planner_engine").notNull(),
    status: text("status").$type<TaskStatus>().notNull().default("QUEUED"),
    priority: integer("priority").notNull().default(5),
    progress: integer("progress").notNull().default(0),
    currentAgentId: text("current_agent_id"),
    currentStepId: text("current_step_id"),
    workDir: text("work_dir").notNull(),
    summary: text("summary"),
    finalAnswer: text("final_answer"),
    error: text("error"),
    controlFlag: text("control_flag"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("tasks_created_idx").on(table.createdAt)],
);

export const planSteps = pgTable(
  "plan_steps",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    stepIndex: integer("step_index").notNull(),
    title: text("title").notNull(),
    detail: text("detail"),
    agentId: text("agent_id").notNull(),
    toolId: text("tool_id"),
    toolInput: jsonb("tool_input").$type<ToolInput>(),
    risk: text("risk").$type<RiskLevel>().notNull().default("LOW"),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    status: text("status").$type<StepStatus>().notNull().default("PENDING"),
    approvalId: text("approval_id"),
    walkMs: integer("walk_ms").notNull().default(1200),
    /** Task-graph wiring: zero-based indexes that must complete first. */
    dependsOn: jsonb("depends_on").$type<number[]>().notNull().default([]),
    /** May run concurrently with other ready steps of the same resource class. */
    parallel: boolean("parallel").notNull().default(false),
    /** HEAVY steps are serialised by the scheduler to keep the machine responsive. */
    resourceClass: text("resource_class").notNull().default("LIGHT"),
    attempts: integer("attempts").notNull().default(0),
    output: jsonb("output").$type<Record<string, unknown>>(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("plan_steps_task_idx").on(table.taskId, table.stepIndex)],
);

export const agentStates = pgTable("agent_states", {
  agentId: text("agent_id").primaryKey(),
  state: text("state").notNull(),
  taskId: text("task_id"),
  stepId: text("step_id"),
  stationId: text("station_id").notNull(),
  lastMessage: text("last_message"),
  mood: text("mood").notNull().default("CALM"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    taskId: text("task_id"),
    runId: text("run_id"),
    agentId: text("agent_id"),
    type: text("type").notNull(),
    message: text("message").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>(),
    severity: text("severity").notNull().default("info"),
  },
  (table) => [index("events_task_idx").on(table.taskId, table.id)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    stepId: text("step_id").notNull(),
    agentId: text("agent_id").notNull(),
    toolId: text("tool_id").notNull(),
    action: jsonb("action").$type<ToolInput>().notNull(),
    risk: text("risk").$type<RiskLevel>().notNull(),
    parametersHash: text("parameters_hash").notNull(),
    reason: text("reason").notNull(),
    target: text("target"),
    status: text("status").notNull().default("PENDING"),
    decision: text("decision"),
    scope: text("scope"),
    note: text("note"),
    tokenHash: text("token_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => [index("approvals_status_idx").on(table.status, table.createdAt)],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    stepId: text("step_id"),
    agentId: text("agent_id"),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    relPath: text("rel_path").notNull(),
    mime: text("mime").notNull().default("application/octet-stream"),
    size: integer("size").notNull().default(0),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    validated: boolean("validated").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("artifacts_task_idx").on(table.taskId)],
);

export const uploads = pgTable("uploads", {
  id: text("id").primaryKey(),
  taskId: text("task_id"),
  originalName: text("original_name").notNull(),
  safeName: text("safe_name").notNull(),
  relPath: text("rel_path").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  sha256: text("sha256").notNull(),
  status: text("status").notNull().default("RECEIVED"),
  extraction: jsonb("extraction").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const securityLog = pgTable("security_log", {
  id: serial("id").primaryKey(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  event: text("event").notNull(),
  toolId: text("tool_id"),
  taskId: text("task_id"),
  allowed: boolean("allowed").notNull(),
  detail: text("detail"),
  data: jsonb("data").$type<Record<string, unknown>>(),
});

export const systemLog = pgTable("system_log", {
  id: serial("id").primaryKey(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  channel: text("channel").notNull(),
  level: text("level").notNull().default("info"),
  taskId: text("task_id"),
  message: text("message").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>(),
});

export const diagnostics = pgTable("diagnostics", {
  id: serial("id").primaryKey(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  report: jsonb("report").$type<Record<string, unknown>>().notNull(),
  durationMs: numeric("duration_ms").notNull().default("0"),
});
