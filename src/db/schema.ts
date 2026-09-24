/**
 * AISHA canonical data model (ONE database, ONE schema).
 *
 * Merged from the strongest parts of both reference projects:
 *  - Project 2: plan_steps with depends_on / resource_class / attempts, approvals with
 *    action hash + expiry, capability snapshots, audit log, tool runs, schema_migrations.
 *  - Project 1: rich agent registry (identity, personality, station, voice) and
 *    agent_states driving the 3D office.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type ResourceClass = "LIGHT" | "MEDIUM" | "HEAVY" | "EXCLUSIVE";

export type StepStatus =
  | "PENDING"
  | "WAITING_DEPENDENCY"
  | "WAITING_APPROVAL"
  | "BLOCKED"
  | "RUNNING"
  | "SUCCESS"
  | "FAILED"
  | "TIMEOUT"
  | "CANCELLED"
  | "UNAVAILABLE"
  | "VERIFICATION_FAILED";

export type TaskStatus = "PLANNING" | "RUNNING" | "WAITING_APPROVAL" | "SUCCESS" | "PARTIAL" | "FAILED" | "CANCELLED";

export type AgentState =
  | "IDLE"
  | "THINKING"
  | "PLANNING"
  | "WORKING"
  | "RESEARCHING"
  | "WAITING"
  | "REQUESTING_APPROVAL"
  | "HANDING_OFF"
  | "RECEIVING"
  | "VERIFYING"
  | "SUCCESS"
  | "FAILED";

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  callsign: text("callsign").notNull(),
  role: text("role").notNull(),
  tier: text("tier").notNull(),
  station: text("station").notNull(),
  color: text("color").notNull(),
  accent: text("accent").notNull(),
  glyph: text("glyph").notNull(),
  personality: text("personality").notNull(),
  capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
  tools: jsonb("tools").$type<string[]>().notNull().default([]),
  riskProfile: text("risk_profile").$type<RiskLevel>().notNull().default("MEDIUM"),
  voice: jsonb("voice").$type<{ rate: number; pitch: number }>().notNull().default({ rate: 1, pitch: 1 }),
  brief: text("brief").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AgentPosition = { x: number; z: number; stationId: string };

export const agentStates = pgTable("agent_states", {
  agentId: text("agent_id").primaryKey(),
  state: text("state").$type<AgentState>().notNull().default("IDLE"),
  taskId: text("task_id"),
  stepId: text("step_id"),
  stationId: text("station_id").notNull(),
  position: jsonb("position").$type<AgentPosition>().notNull(),
  walk: jsonb("walk")
    .$type<{ from: AgentPosition; to: AgentPosition; startedAt: number; durationMs: number; mode: string } | null>()
    .default(null),
  payload: jsonb("payload").$type<Record<string, unknown> | null>().default(null),
  lastMessage: text("last_message"),
  mood: text("mood").notNull().default("CALM"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    request: text("request").notNull(),
    intent: text("intent").notNull(),
    engine: text("engine").notNull(),
    status: text("status").$type<TaskStatus>().notNull().default("PLANNING"),
    risk: text("risk").$type<RiskLevel>().notNull().default("LOW"),
    planSummary: text("plan_summary").notNull().default(""),
    plan: jsonb("plan").$type<Record<string, unknown>>().notNull().default({}),
    result: text("result"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
    stats: jsonb("stats")
      .$type<{ steps: number; succeeded: number; failed: number; artifacts: number; approvals: number; ms: number }>()
      .notNull()
      .default({ steps: 0, succeeded: 0, failed: 0, artifacts: 0, approvals: 0, ms: 0 }),
    error: text("error"),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    cancelVerified: jsonb("cancel_verified").$type<Record<string, unknown> | null>().default(null),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("tasks_created_idx").on(t.createdAt)],
);

export const steps = pgTable(
  "steps",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    stepIndex: integer("step_index").notNull(),
    title: text("title").notNull(),
    agentId: text("agent_id").notNull(),
    toolId: text("tool_id").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    dependsOn: jsonb("depends_on").$type<string[]>().notNull().default([]),
    parallel: boolean("parallel").notNull().default(false),
    resourceClass: text("resource_class").$type<ResourceClass>().notNull().default("LIGHT"),
    risk: text("risk").$type<RiskLevel>().notNull().default("LOW"),
    status: text("status").$type<StepStatus>().notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(2),
    approvalId: text("approval_id"),
    output: jsonb("output").$type<Record<string, unknown> | null>().default(null),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
    verification: jsonb("verification")
      .$type<{ verified: boolean; method: string; detail: string } | null>()
      .default(null),
    deferral: text("deferral"),
    error: text("error"),
    ms: integer("ms").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("steps_task_idx").on(t.taskId, t.stepIndex)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    stepId: text("step_id").notNull(),
    agentId: text("agent_id").notNull(),
    action: text("action").notNull(),
    target: text("target").notNull().default(""),
    reason: text("reason").notNull(),
    risk: text("risk").$type<RiskLevel>().notNull(),
    actionHash: text("action_hash").notNull(),
    token: text("token").notNull(),
    status: text("status").notNull().default("PENDING"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by"),
    decisionNote: text("decision_note"),
  },
  (t) => [index("approvals_status_idx").on(t.status)],
);

export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    topic: text("topic").notNull(),
    taskId: text("task_id"),
    stepId: text("step_id"),
    agentId: text("agent_id"),
    level: text("level").notNull().default("info"),
    message: text("message").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("events_task_idx").on(t.taskId), index("events_at_idx").on(t.at)],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id"),
    stepId: text("step_id"),
    agentId: text("agent_id"),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    path: text("path").notNull(),
    mimeType: text("mime_type").notNull().default("application/octet-stream"),
    bytes: integer("bytes").notNull().default(0),
    sha256: text("sha256").notNull(),
    origin: text("origin").notNull().default("deterministic"),
    validation: jsonb("validation").$type<{ valid: boolean; method: string; detail: string }>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("artifacts_task_idx").on(t.taskId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    target: text("target").notNull().default(""),
    risk: text("risk").$type<RiskLevel>().notNull().default("LOW"),
    decision: text("decision").notNull().default("ALLOWED"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_at_idx").on(t.at)],
);

export const toolRuns = pgTable(
  "tool_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id"),
    stepId: text("step_id"),
    toolId: text("tool_id").notNull(),
    risk: text("risk").$type<RiskLevel>().notNull(),
    status: text("status").notNull(),
    ms: integer("ms").notNull().default(0),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb("result").$type<Record<string, unknown> | null>().default(null),
    error: text("error"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tool_runs_tool_idx").on(t.toolId)],
);

export const capabilitySnapshots = pgTable("capability_snapshots", {
  id: serial("id").primaryKey(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  summary: text("summary").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export const resourceSamples = pgTable("resource_samples", {
  id: serial("id").primaryKey(),
  cpuPercent: integer("cpu_percent").notNull(),
  loadPerCore: integer("load_per_core_x100").notNull(),
  totalMemMb: integer("total_mem_mb").notNull(),
  freeMemMb: integer("free_mem_mb").notNull(),
  diskFreeMb: integer("disk_free_mb").notNull(),
  activeSteps: integer("active_steps").notNull().default(0),
  pressure: text("pressure").notNull().default("NORMAL"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export const testRuns = pgTable("test_runs", {
  id: text("id").primaryKey(),
  suite: text("suite").notNull(),
  passed: integer("passed").notNull(),
  failed: integer("failed").notNull(),
  total: integer("total").notNull(),
  ms: integer("ms").notNull().default(0),
  results: jsonb("results")
    .$type<Array<{ id: string; area: string; name: string; status: string; detail: string; ms: number }>>()
    .notNull()
    .default([]),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id"),
    role: text("role").notNull(),
    content: text("content").notNull(),
    engine: text("engine"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_task_idx").on(t.taskId)],
);

export const schemaMigrations = pgTable("schema_migrations", {
  version: text("version").primaryKey(),
  checksum: text("checksum").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  durationMs: integer("duration_ms").notNull().default(0),
});

export type AgentRow = typeof agents.$inferSelect;
export type AgentStateRow = typeof agentStates.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type StepRow = typeof steps.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type AuditRow = typeof auditLogs.$inferSelect;
export type ToolRunRow = typeof toolRuns.$inferSelect;
export type TestRunRow = typeof testRuns.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
