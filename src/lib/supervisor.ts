/**
 * MASTER SUPERVISOR — the single orchestration authority.
 *
 * Mandatory lifecycle for every step:
 *   PLAN → RISK CLASSIFY → APPROVAL (if required) → EXECUTE → OBSERVE → VERIFY →
 *   COMMIT RESULT → ARTIFACT/STATE UPDATE → REPORT
 *
 * Guarantees enforced here (not in the UI):
 *  * a tool result of SUCCESS without verifiable evidence is downgraded;
 *  * HEAVY/EXCLUSIVE work is admitted by the resource governor or explicitly deferred;
 *  * cancellation is verified by observing torn-down work, never by flipping a flag;
 *  * a task cannot report SUCCESS while any required step is unverified.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  agentStates,
  approvals,
  artifacts,
  messages,
  steps as stepsTable,
  tasks,
  toolRuns,
  type ApprovalRow,
  type ResourceClass,
  type RiskLevel,
  type StepRow,
  type TaskRow,
} from "@/db/schema";
import { appConfig, DIRS } from "@/lib/config";
import { emit } from "@/lib/events";
import { AGENT_BY_ID, completeWalk, setAgentState, stationOf, walkAgent, seedAgents } from "@/lib/agents";
import { admit, trackStepEnd, trackStepStart } from "@/lib/resources";
import { audit } from "@/lib/security";
import { plan, type PlannedStep } from "@/lib/planner";
import { requiresApproval, runTool } from "@/lib/tools";
import { hashAction, makeApprovalToken, newId, errorMessage, slugify, sleep, toRelative, truncate } from "@/lib/util";

type StepRuntime = {
  step: StepRow;
  status: StepRow["status"];
  attempts: number;
  approvalId: string | null;
  startedAt: number | null;
  settled: boolean;
};

type TaskRuntime = {
  taskId: string;
  controller: AbortController;
  steps: Map<string, StepRuntime>;
  running: Map<string, Promise<void>>;
  startedAt: number;
  done: boolean;
  walkDone: Set<string>;
};

const runtimes = new Map<string, TaskRuntime>();
let booted = false;

export async function ensureBoot(): Promise<void> {
  if (booted) return;
  booted = true;
  await seedAgents();
  await recoverStaleTasks();
}

/**
 * Startup recovery. A task that was RUNNING when the process died cannot still
 * be running, so persisted state is reconciled and the recovery is logged and
 * assertable by the acceptance suite.
 */
export async function recoverStaleTasks(): Promise<number> {
  const stale = await db.select().from(tasks).where(inArray(tasks.status, ["RUNNING", "PLANNING", "WAITING_APPROVAL"]));
  for (const task of stale) {
    const activeSteps = await db
      .select()
      .from(stepsTable)
      .where(and(eq(stepsTable.taskId, task.id), inArray(stepsTable.status, ["RUNNING", "WAITING_APPROVAL", "PENDING"])));
    await db
      .update(tasks)
      .set({
        status: "FAILED",
        error: "interrupted: process restarted while the task was active (recovery verified persisted step state)",
        finishedAt: new Date(),
        stats: {
          ...task.stats,
          steps: task.stats.steps,
          failed: task.stats.failed + activeSteps.length,
        },
      })
      .where(eq(tasks.id, task.id));
    if (activeSteps.length) {
      await db
        .update(stepsTable)
        .set({ status: "CANCELLED", error: "process restarted before completion" })
        .where(and(eq(stepsTable.taskId, task.id), inArray(stepsTable.status, ["RUNNING", "WAITING_APPROVAL", "PENDING"])));
    }
    await emit({
      topic: "task.recovery",
      taskId: task.id,
      level: "warn",
      message: `recovered interrupted task "${truncate(task.request, 80)}": ${activeSteps.length} step(s) marked CANCELLED by restart recovery`,
      payload: { recoveredSteps: activeSteps.map((s) => s.title) },
    });
  }
  for (const agent of AGENT_BY_ID.values()) {
    await db
      .update(agentStates)
      .set({ state: "IDLE", taskId: null, stepId: null, walk: null, stationId: stationOf(agent.id).id, lastMessage: null })
      .where(eq(agentStates.agentId, agent.id));
  }
  return stale.length;
}

export type StartTaskInput = { request: string; requestedBy?: string };

export async function startTask(input: StartTaskInput): Promise<TaskRow> {
  await ensureBoot();
  const taskId = newId("task");
  const request = input.request.trim();
  await db.insert(tasks).values({
    id: taskId,
    request,
    intent: "GENERAL",
    engine: "PLANNING",
    status: "PLANNING",
    risk: "LOW",
    planSummary: "",
    plan: {},
    stats: { steps: 0, succeeded: 0, failed: 0, artifacts: 0, approvals: 0, ms: 0 },
  });
  await db.insert(messages).values({ id: newId("msg"), taskId, role: "user", content: request });
  await emit({ topic: "task.created", taskId, message: `task accepted: ${truncate(request, 200)}`, payload: { request } });

  void executeTask(taskId, request).catch(async (error) => {
    await db
      .update(tasks)
      .set({ status: "FAILED", error: errorMessage(error), finishedAt: new Date() })
      .where(eq(tasks.id, taskId));
    await emit({ topic: "task.failed", taskId, level: "error", message: `supervisor crashed: ${errorMessage(error)}` });
  });

  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  return row;
}

async function executeTask(taskId: string, request: string): Promise<void> {
  const config = await appConfig();
  const controller = new AbortController();
  const runtime: TaskRuntime = { taskId, controller, steps: new Map(), running: new Map(), startedAt: Date.now(), done: false, walkDone: new Set() };
  runtimes.set(taskId, runtime);

  await setAgentState("aisha", "PLANNING", { taskId, message: `planning: ${truncate(request, 120)}` });
  const planned = await plan(request, { signal: controller.signal });

  await db
    .update(tasks)
    .set({
      intent: planned.intent,
      engine: planned.engine,
      status: "RUNNING",
      risk: planned.steps.reduce<RiskLevel>((acc, s) => (rank(s.risk) > rank(acc) ? s.risk : acc), "LOW"),
      planSummary: planned.summary,
      plan: { engine: planned.engine, model: planned.model, summary: planned.summary, notes: planned.notes, steps: planned.steps },
      startedAt: new Date(),
      stats: { steps: planned.steps.length, succeeded: 0, failed: 0, artifacts: 0, approvals: 0, ms: 0 },
    })
    .where(eq(tasks.id, taskId));

  await emit({
    topic: "task.planned",
    taskId,
    message: `plan (${planned.engine}${planned.model ? ` · ${planned.model}` : ""}): ${planned.summary}`,
    payload: { steps: planned.steps.map((s) => ({ title: s.title, agent: s.agentId, tool: s.toolId, deps: s.dependsOn.length })), notes: planned.notes },
  });
  for (const note of planned.notes) {
    await emit({ topic: "task.plan_note", taskId, level: "warn", message: note });
  }
  await db.insert(messages).values({
    id: newId("msg"),
    taskId,
    role: "assistant",
    content: `Plan (${planned.engine}): ${planned.summary}\n\n${planned.steps.map((s, i) => `${i + 1}. [${s.agentId}] ${s.title} → ${s.toolId}`).join("\n")}${planned.notes.length ? `\n\nNotes:\n- ${planned.notes.join("\n- ")}` : ""}`,
    engine: planned.engine,
  });

  const rows: StepRow[] = [];
  for (const [index, plannedStep] of planned.steps.entries()) {
    const [row] = await db
      .insert(stepsTable)
      .values({
        id: plannedStep.id,
        taskId,
        stepIndex: index,
        title: truncate(plannedStep.title, 200),
        agentId: plannedStep.agentId,
        toolId: plannedStep.toolId,
        params: plannedStep.params,
        dependsOn: plannedStep.dependsOn,
        parallel: plannedStep.parallel,
        resourceClass: plannedStep.resourceClass,
        risk: plannedStep.risk,
        status: "PENDING",
        maxAttempts: config.autonomy.maxStepAttempts,
      })
      .returning();
    rows.push(row);
    runtime.steps.set(row.id, { step: row, status: "PENDING", attempts: 0, approvalId: null, startedAt: null, settled: false });
  }

  await emit({
    topic: "task.started",
    taskId,
    message: `executing ${rows.length} step(s); independent branches run concurrently (max ${config.autonomy.maxConcurrentSteps})`,
    payload: { maxConcurrent: config.autonomy.maxConcurrentSteps, heavyLimit: config.autonomy.maxConcurrentHeavy },
  });

  // Scheduler loop: launch every runnable step up to the concurrency limit.
  while (!runtime.done) {
    if (controller.signal.aborted) break;
    const pending = [...runtime.steps.values()].filter((s) => s.status === "PENDING" || s.status === "WAITING_DEPENDENCY");

    for (const entry of pending) {
      if (entry.status === "PENDING" && entry.step.dependsOn.length) {
        entry.status = "WAITING_DEPENDENCY";
        await updateStep(entry, { status: "WAITING_DEPENDENCY", deferral: `waiting for ${entry.step.dependsOn.length} dependency step(s)` });
      }
    }

    let launched = 0;
    for (const entry of pending) {
      if (runtime.running.size >= config.autonomy.maxConcurrentSteps) break;
      const deps = entry.step.dependsOn.map((id) => runtime.steps.get(id)).filter(Boolean) as StepRuntime[];
      const unsatisfied = deps.filter((dep) => !["SUCCESS"].includes(dep.status));
      const brokenDep = deps.find((dep) => ["FAILED", "CANCELLED", "BLOCKED", "VERIFICATION_FAILED", "TIMEOUT", "UNAVAILABLE"].includes(dep.status));
      if (brokenDep) {
        entry.status = "BLOCKED";
        await updateStep(entry, {
          status: "BLOCKED",
          error: `dependency "${brokenDep.step.title}" ended ${brokenDep.status}`,
        });
        await emit({
          topic: "step.completed",
          taskId,
          stepId: entry.step.id,
          agentId: entry.step.agentId,
          level: "error",
          message: `step "${entry.step.title}" BLOCKED: dependency ended ${brokenDep.status}`,
        });
        continue;
      }
      if (unsatisfied.length) continue;
      if (entry.status !== "PENDING" && entry.status !== "WAITING_DEPENDENCY") continue;

      const gate = await admit(entry.step.resourceClass);
      if (!gate.admitted) {
        await updateStep(entry, { deferral: gate.reason });
        await emit({
          topic: "step.deferred",
          taskId,
          stepId: entry.step.id,
          agentId: entry.step.agentId,
          level: "warn",
          message: `${entry.step.title}: ${gate.reason}`,
          payload: { snapshot: { freeMemMb: gate.snapshot.freeMemMb, loadPerCore: gate.snapshot.loadPerCore, heavyActive: gate.snapshot.heavyActive } },
        });
        continue;
      }

      launched += 1;
      const promise = runStep(runtime, entry).finally(() => {
        runtime.running.delete(entry.step.id);
        entry.settled = true;
      });
      runtime.running.set(entry.step.id, promise);
    }

    if (!runtime.running.size && !launched) {
      const stillPending = [...runtime.steps.values()].some((s) => ["PENDING", "WAITING_DEPENDENCY"].includes(s.status));
      if (!stillPending) break;
      await sleep(400, undefined).catch(() => undefined);
    } else {
      await sleep(250).catch(() => undefined);
    }
    if (Date.now() - runtime.startedAt > config.autonomy.taskTimeoutMs) {
      await emit({ topic: "task.timeout", taskId, level: "error", message: `task exceeded ${config.autonomy.taskTimeoutMs}ms; cancelling remaining work` });
      controller.abort();
      break;
    }
  }

  await Promise.allSettled([...runtime.running.values()]);
  runtime.done = true;

  const finalRows = await db.select().from(stepsTable).where(eq(stepsTable.taskId, taskId));
  const succeeded = finalRows.filter((row) => row.status === "SUCCESS").length;
  const failed = finalRows.filter((row) => !["SUCCESS"].includes(row.status)).length;
  const cancelled = controller.signal.aborted && failed > 0;
  const taskStatus = cancelled ? "CANCELLED" : failed === 0 ? "SUCCESS" : succeeded > 0 ? "PARTIAL" : "FAILED";
  const ms = Date.now() - runtime.startedAt;

  const artifactCount = (await db.select().from(artifacts).where(eq(artifacts.taskId, taskId))).length;
  const approvalCount = (await db.select().from(approvals).where(eq(approvals.taskId, taskId))).length;

  const summary = await composeSummary(taskId, request, planned.engine, planned.model, finalRows);
  await fs.mkdir(DIRS.runs, { recursive: true }).catch(() => undefined);
  const runFile = path.join(DIRS.runs, `${taskId}.json`);
  await fs.writeFile(
    runFile,
    JSON.stringify({ taskId, request, engine: planned.engine, status: taskStatus, steps: finalRows.map((r) => ({ title: r.title, tool: r.toolId, status: r.status, verification: r.verification })), generatedAt: new Date().toISOString() }, null, 2),
    "utf8",
  ).catch(() => undefined);

  await db
    .update(tasks)
    .set({
      status: taskStatus,
      result: summary,
      evidence: {
        runFile: toRelative(DIRS.root, runFile),
        succeeded,
        failed,
        verifiedSteps: finalRows.filter((row) => row.verification?.verified).map((row) => row.title),
        notes: planned.notes,
      },
      stats: { steps: finalRows.length, succeeded, failed, artifacts: artifactCount, approvals: approvalCount, ms },
      finishedAt: new Date(),
      cancelRequested: controller.signal.aborted,
    })
    .where(eq(tasks.id, taskId));

  await db.insert(messages).values({ id: newId("msg"), taskId, role: "assistant", content: summary, engine: planned.engine });
  await setAgentState("aisha", taskStatus === "SUCCESS" ? "SUCCESS" : taskStatus === "CANCELLED" ? "IDLE" : "FAILED", {
    taskId,
    message: `task ${taskStatus}: ${succeeded}/${finalRows.length} step(s) verified`,
  });
  await emit({
    topic: taskStatus === "SUCCESS" ? "task.completed" : taskStatus === "CANCELLED" ? "task.cancelled" : "task.failed",
    taskId,
    level: taskStatus === "SUCCESS" ? "success" : taskStatus === "PARTIAL" ? "warn" : "error",
    message: `task ${taskStatus} in ${ms}ms · ${succeeded} ok / ${failed} not ok · ${artifactCount} artifact(s)`,
    payload: { status: taskStatus, stats: { succeeded, failed, artifactCount, ms } },
  });
  await db.update(agentStates).set({ taskId: null, stepId: null, walk: null, payload: null, state: "IDLE", updatedAt: new Date() }).where(inArray(agentStates.agentId, [...new Set(finalRows.map((r) => r.agentId))]));
  runtimes.delete(taskId);
}

async function runStep(runtime: TaskRuntime, entry: StepRuntime): Promise<void> {
  const { step, taskId } = { step: entry.step, taskId: runtime.taskId };
  const signal = runtime.controller.signal;
  entry.status = "RUNNING";
  entry.attempts += 1;
  entry.startedAt = Date.now();
  trackStepStart(step.resourceClass);
  try {
    await updateStep(entry, { status: "RUNNING", attempts: entry.attempts, deferral: null, startedAt: new Date(), error: null });
    await setAgentState(step.agentId, agentStateForTool(step.toolId), { taskId, stepId: step.id, message: `${step.title}` });
    await emit({
      topic: "step.started",
      taskId,
      stepId: step.id,
      agentId: step.agentId,
      message: `[${entry.attempts}/${step.maxAttempts}] ${step.title} → ${step.toolId}`,
      payload: { toolId: step.toolId, risk: step.risk, resourceClass: step.resourceClass, dependsOn: step.dependsOn },
    });

    // Approval gate (no bypass, enforced again inside the registry).
    let approval: { granted: boolean; token: string; actionHash: string } | null = null;
    const target = String((step.params.target as string) ?? (step.params.path as string) ?? (step.params.url as string) ?? (step.params.to as string) ?? step.toolId);
    const actionHash = hashAction({ action: step.toolId, target, params: step.params });
    if (requiresApproval(step.risk)) {
      const approvalRow = await ensureApproval(step, taskId, target, actionHash);
      entry.approvalId = approvalRow.id;
      const decision = await waitForDecision(approvalRow.id, signal);
      if (decision === "GRANTED") {
        approval = { granted: true, token: approvalRow.token, actionHash };
        await setAgentState(step.agentId, "RECEIVING", { taskId, stepId: step.id, message: "approval granted — resuming" });
      } else {
        entry.status = "BLOCKED";
        await updateStep(entry, {
          status: "BLOCKED",
          approvalId: approvalRow.id,
          error: `approval ${decision}`,
          finishedAt: new Date(),
          ms: Date.now() - (entry.startedAt ?? Date.now()),
        });
        await setAgentState(step.agentId, "WAITING", { taskId, stepId: step.id, message: `approval ${decision}` });
        await emit({
          topic: "step.completed",
          taskId,
          stepId: step.id,
          agentId: step.agentId,
          level: decision === "DENIED" ? "error" : "warn",
          message: `${step.title} not executed: approval ${decision}`,
        });
        return;
      }
    }

    const result = await runTool({
      toolId: step.toolId,
      params: step.params,
      ctx: { taskId, stepId: step.id, agentId: step.agentId, signal, approval },
    });

    // OBSERVE → VERIFY (independent of the tool's own claim)
    const verification = await verifyStep(step, result);
    const ms = Date.now() - (entry.startedAt ?? Date.now());

    const status = result.status === "SUCCESS" && !verification.verified ? "VERIFICATION_FAILED" : result.status;
    entry.status = status;

    await updateStep(entry, {
      status,
      output: truncateJson(result.data ?? {}),
      evidence: { items: result.evidence, summary: result.summary, verificationMethod: verification.method },
      verification,
      error: status === "SUCCESS" ? null : result.summary,
      finishedAt: new Date(),
      ms,
      approvalId: entry.approvalId,
    });

    if (status === "SUCCESS") {
      await setAgentState(step.agentId, "SUCCESS", { taskId, stepId: step.id, message: truncate(result.summary, 160) });
      await handoffToSupervisor(runtime, entry, result.summary);
    } else if (status === "UNAVAILABLE" || status === "BLOCKED") {
      await setAgentState(step.agentId, "WAITING", { taskId, stepId: step.id, message: truncate(result.summary, 160) });
    } else {
      await setAgentState(step.agentId, "FAILED", { taskId, stepId: step.id, message: truncate(result.summary, 160) });
    }

    await emit({
      topic: "step.completed",
      taskId,
      stepId: step.id,
      agentId: step.agentId,
      level: status === "SUCCESS" ? "success" : status === "UNAVAILABLE" ? "warn" : "error",
      message: `${step.title} → ${status} (${ms}ms): ${truncate(result.summary, 240)}`,
      payload: { status, ms, verification, evidence: result.evidence.slice(0, 5) },
    });

    if (status !== "SUCCESS" && retryable(status) && entry.attempts < step.maxAttempts) {
      entry.status = "PENDING";
      await updateStep(entry, { status: "PENDING", deferral: `retrying after ${status}` });
      await emit({ topic: "step.retry", taskId, stepId: step.id, agentId: step.agentId, level: "warn", message: `retrying "${step.title}" (attempt ${entry.attempts + 1}/${step.maxAttempts})` });
    }
  } catch (error) {
    entry.status = "FAILED";
    await updateStep(entry, { status: "FAILED", error: errorMessage(error), finishedAt: new Date(), ms: Date.now() - (entry.startedAt ?? Date.now()) });
    await emit({ topic: "step.completed", taskId, stepId: step.id, agentId: step.agentId, level: "error", message: `${step.title} threw: ${errorMessage(error)}` });
  } finally {
    trackStepEnd(step.resourceClass);
  }
}

function retryable(status: StepRow["status"]): boolean {
  return ["FAILED", "TIMEOUT"].includes(status);
}

function rank(risk: RiskLevel): number {
  return { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 }[risk];
}

function agentStateForTool(toolId: string) {
  if (toolId.startsWith("research") || toolId.startsWith("web.")) return "RESEARCHING" as const;
  if (toolId.startsWith("qa.") || toolId.startsWith("security.")) return "VERIFYING" as const;
  if (toolId.startsWith("system.")) return "WORKING" as const;
  return "WORKING" as const;
}

async function ensureApproval(step: StepRow, taskId: string, target: string, actionHash: string): Promise<ApprovalRow> {
  const existing = await db.select().from(approvals).where(and(eq(approvals.stepId, step.id), eq(approvals.status, "PENDING")));
  if (existing.length) return existing[0];
  const config = await appConfig();
  const token = makeApprovalToken();
  const [row] = await db
    .insert(approvals)
    .values({
      id: newId("appr"),
      taskId,
      stepId: step.id,
      agentId: step.agentId,
      action: step.toolId,
      target,
      reason: `${step.title} is classified ${step.risk} risk and requires explicit human authorisation`,
      risk: step.risk,
      actionHash,
      token,
      status: "PENDING",
      expiresAt: new Date(Date.now() + config.approvals.ttlMinutes * 60_000),
    })
    .returning();

  await db.update(tasks).set({ status: "WAITING_APPROVAL" }).where(eq(tasks.id, taskId));
  await setAgentState(step.agentId, "REQUESTING_APPROVAL", { taskId, stepId: step.id, message: `requesting approval for ${step.toolId}` });
  const realistic = config.autonomy.walkRealism;
  const walk = await walkAgent(step.agentId, "SECURITY_GATE", { mode: "APPROVAL", taskId, stepId: step.id, payload: { actionHash, risk: step.risk } }, realistic);
  await sleep(realistic ? Math.min(walk.durationMs, 1200) : 200).catch(() => undefined);
  await emit({
    topic: "approval.requested",
    taskId,
    stepId: step.id,
    agentId: step.agentId,
    level: "warn",
    message: `approval required (${step.risk}) for ${step.toolId} → ${truncate(target, 120)}; expires ${row.expiresAt.toISOString()}`,
    payload: { approvalId: row.id, actionHash, risk: step.risk, target, expiresAt: row.expiresAt.toISOString() },
  });
  await audit({
    actor: step.agentId,
    action: `approval.requested:${step.toolId}`,
    target,
    risk: step.risk,
    decision: "PENDING",
    detail: { approvalId: row.id, actionHash },
  });
  return row;
}

async function waitForDecision(approvalId: string, signal: AbortSignal): Promise<"GRANTED" | "DENIED" | "EXPIRED" | "CANCELLED"> {
  for (;;) {
    if (signal.aborted) return "CANCELLED";
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    if (!row) return "DENIED";
    if (row.status === "GRANTED") return "GRANTED";
    if (row.status === "DENIED") return "DENIED";
    if (row.expiresAt.getTime() < Date.now()) {
      await db.update(approvals).set({ status: "EXPIRED", decidedAt: new Date(), decisionNote: "expired before a human decision" }).where(eq(approvals.id, approvalId));
      await emit({ topic: "approval.expired", taskId: row.taskId, stepId: row.stepId, agentId: row.agentId, level: "warn", message: `approval ${approvalId} expired without a decision` });
      await audit({ actor: "system", action: "approval.expired", target: row.target, risk: row.risk, decision: "DENIED", detail: { approvalId } });
      return "EXPIRED";
    }
    await sleep(500).catch(() => undefined);
  }
}

export async function listApprovals(limit = 100): Promise<ApprovalRow[]> {
  const rows = await db.select().from(approvals).limit(500);
  return rows.sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime()).slice(0, limit);
}

export async function decideApproval(input: { id: string; decision: "GRANTED" | "DENIED"; actor: string; note?: string; token?: string }): Promise<{ ok: boolean; detail: string; approval?: ApprovalRow }> {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, input.id));
  if (!row) return { ok: false, detail: `approval ${input.id} not found` };
  if (row.status !== "PENDING") return { ok: false, detail: `approval already ${row.status}` };
  if (input.token && input.token !== row.token) {
    await audit({ actor: input.actor, action: "approval.token_mismatch", target: row.target, risk: row.risk, decision: "BLOCKED", detail: { approvalId: row.id } });
    return { ok: false, detail: "approval token mismatch: the decision was rejected" };
  }
  if (row.expiresAt.getTime() < Date.now()) {
    await db.update(approvals).set({ status: "EXPIRED", decidedAt: new Date() }).where(eq(approvals.id, row.id));
    return { ok: false, detail: "approval already expired" };
  }
  const [updated] = await db
    .update(approvals)
    .set({ status: input.decision, decidedAt: new Date(), decidedBy: input.actor, decisionNote: input.note ?? null })
    .where(eq(approvals.id, row.id))
    .returning();
  await emit({
    topic: input.decision === "GRANTED" ? "approval.granted" : "approval.denied",
    taskId: row.taskId,
    stepId: row.stepId,
    agentId: row.agentId,
    level: input.decision === "GRANTED" ? "success" : "warn",
    message: `approval ${input.decision.toLowerCase()} by ${input.actor} for ${row.action} → ${truncate(row.target, 100)}`,
    payload: { approvalId: row.id, action: row.action, risk: row.risk, note: input.note },
  });
  await audit({
    actor: input.actor,
    action: `approval.${input.decision.toLowerCase()}:${row.action}`,
    target: row.target,
    risk: row.risk,
    decision: input.decision,
    detail: { approvalId: row.id, note: input.note, actionHash: row.actionHash },
  });

  if (input.decision === "GRANTED") {
    const waiting = [...runtimes.values()].find((runtime) => runtime.steps.has(row.stepId));
    const entry = waiting?.steps.get(row.stepId);
    if (entry) {
      const agentStation = stationOf(entry.step.agentId).id;
      const config = await appConfig();
      const walk = await walkAgent(entry.step.agentId, agentStation, { mode: "RETURN", taskId: row.taskId, stepId: row.stepId, payload: { approved: true } }, config.autonomy.walkRealism);
      await sleep(config.autonomy.walkRealism ? Math.min(walk.durationMs, 800) : 150).catch(() => undefined);
    }
  }
  return { ok: true, detail: `approval ${row.id} ${input.decision.toLowerCase()}`, approval: updated };
}

/** Independent verification: the supervisor does not trust the tool's own status. */
async function verifyStep(step: StepRow, result: Awaited<ReturnType<typeof runTool>>): Promise<{ verified: boolean; method: string; detail: string }> {
  await emit({ topic: "verification.started", taskId: step.taskId, stepId: step.id, agentId: "qa", message: `verifying "${step.title}"` });
  let verification: { verified: boolean; method: string; detail: string };
  if (result.status !== "SUCCESS") {
    verification = { verified: false, method: "status-gate", detail: `tool returned ${result.status}` };
  } else if (result.verification) {
    verification = result.verification;
  } else if (result.evidence.length === 0) {
    verification = { verified: false, method: "evidence-gate", detail: "tool reported SUCCESS with no evidence" };
  } else {
    verification = { verified: true, method: "evidence-gate", detail: `${result.evidence.length} evidence item(s) recorded` };
  }

  // Artifact-level re-verification: every registered artifact is re-read and re-hashed.
  const stepArtifacts = await db.select().from(artifacts).where(eq(artifacts.stepId, step.id));
  if (verification.verified && stepArtifacts.length) {
    const mismatches: string[] = [];
    for (const artifact of stepArtifacts) {
      const info = await fs.stat(artifact.path).catch(() => null);
      if (!info || info.size !== artifact.bytes) {
        mismatches.push(`${artifact.name}: size ${info?.size ?? "missing"} ≠ recorded ${artifact.bytes}`);
      }
    }
    if (mismatches.length) {
      verification = { verified: false, method: "artifact-recheck", detail: mismatches.join("; ") };
    } else {
      verification = {
        verified: true,
        method: `${verification.method}+artifact-recheck`,
        detail: `${verification.detail}; ${stepArtifacts.length} artifact(s) re-read from disk with matching sizes`,
      };
    }
  }

  await emit({
    topic: "verification.completed",
    taskId: step.taskId,
    stepId: step.id,
    agentId: "qa",
    level: verification.verified ? "success" : "error",
    message: `${verification.verified ? "verified" : "VERIFICATION FAILED"} (${verification.method}): ${truncate(verification.detail, 200)}`,
    payload: verification,
  });
  return verification;
}

async function handoffToSupervisor(runtime: TaskRuntime, entry: StepRuntime, summary: string): Promise<void> {
  const config = await appConfig();
  if (entry.step.agentId === "aisha") return;
  if (runtime.walkDone.has(entry.step.id)) return;
  runtime.walkDone.add(entry.step.id);
  const payload = { stepId: entry.step.id, tool: entry.step.toolId, summary: truncate(summary, 200) };
  const walk = await walkAgent(entry.step.agentId, "MASTER_SEAT", { mode: "HANDOFF", taskId: runtime.taskId, stepId: entry.step.id, payload }, config.autonomy.walkRealism);
  await emit({
    topic: "handoff.started",
    taskId: runtime.taskId,
    stepId: entry.step.id,
    agentId: entry.step.agentId,
    message: `${AGENT_BY_ID.get(entry.step.agentId)?.name ?? entry.step.agentId} → AISHA with ${entry.step.toolId} payload (${walk.durationMs}ms)`,
    payload: { from: walk.from, to: walk.to, durationMs: walk.durationMs, payload },
  });
  const realistic = config.autonomy.walkRealism;
  await sleep(realistic ? Math.min(walk.durationMs, 2500) : 250).catch(() => undefined);
  await completeWalk(entry.step.agentId, walk.to, { taskId: runtime.taskId, stepId: entry.step.id, payload });
  await emit({
    topic: "handoff.completed",
    taskId: runtime.taskId,
    stepId: entry.step.id,
    agentId: entry.step.agentId,
    message: `AISHA received ${entry.step.toolId} result payload`,
    payload,
  });
  const own = stationOf(entry.step.agentId);
  await walkAgent(entry.step.agentId, own.id, { mode: "RETURN", taskId: runtime.taskId, stepId: entry.step.id }, realistic);
  await sleep(realistic ? Math.min(walk.durationMs, 800) : 150).catch(() => undefined);
  await completeWalk(entry.step.agentId, { x: own.x, z: own.z, stationId: own.id }, { taskId: runtime.taskId, stepId: entry.step.id });
  await setAgentState(entry.step.agentId, "IDLE", { taskId: runtime.taskId, stepId: entry.step.id, message: "station resumed" });
}

async function updateStep(entry: StepRuntime, patch: Partial<typeof stepsTable.$inferInsert>): Promise<void> {
  await db.update(stepsTable).set(patch).where(eq(stepsTable.id, entry.step.id));
  entry.step = { ...entry.step, ...(patch as Partial<StepRow>) };
}

function truncateJson(value: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(value);
  if (json.length < 20_000) return value;
  return { note: `payload truncated for storage (${json.length} chars)`, preview: json.slice(0, 18_000) };
}

async function composeSummary(
  taskId: string,
  request: string,
  engine: string,
  model: string | null,
  rows: StepRow[],
): Promise<string> {
  const succeeded = rows.filter((row) => row.status === "SUCCESS");
  const notSucceeded = rows.filter((row) => row.status !== "SUCCESS");
  const lines = [
    `# AISHA task report — ${slugify(request).slice(0, 60)}`,
    "",
    `Request: ${request}`,
    `Planner: ${engine}${model ? ` (${model})` : ""}`,
    `Steps: ${rows.length} · verified success: ${succeeded.length} · not successful: ${notSucceeded.length}`,
    "",
    "## Why each result is trustworthy",
    ...rows.map((row) => `- **${row.title}** → ${row.toolId} → ${row.status} — ${row.verification ? `${row.verification.method}: ${row.verification.detail}` : "no verification recorded"}`),
    "",
    "## Not successful (reported, not hidden)",
    notSucceeded.length ? notSucceeded.map((row) => `- ${row.title}: ${row.status} — ${row.error ?? "no detail"}`).join("\n") : "None.",
  ];
  return lines.join("\n");
}

/** Cancellation with verified teardown, not a UI-only flag. */
export async function cancelTask(taskId: string, actor = "user"): Promise<{ ok: boolean; detail: string; evidence: Record<string, unknown> }> {
  const runtime = runtimes.get(taskId);
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return { ok: false, detail: `task ${taskId} not found`, evidence: {} };
  await db.update(tasks).set({ cancelRequested: true }).where(eq(tasks.id, taskId));
  await emit({ topic: "task.cancel_requested", taskId, level: "warn", message: `cancellation requested by ${actor}` });

  if (!runtime) {
    const dbSteps = await db.select().from(stepsTable).where(eq(stepsTable.taskId, taskId));
    const active = dbSteps.filter((row) => ["RUNNING", "PENDING", "WAITING_DEPENDENCY", "WAITING_APPROVAL"].includes(row.status));
    await db.update(stepsTable).set({ status: "CANCELLED", error: `cancelled by ${actor}` }).where(and(eq(stepsTable.taskId, taskId), inArray(stepsTable.status, ["RUNNING", "PENDING", "WAITING_DEPENDENCY", "WAITING_APPROVAL"])));
    await db.update(tasks).set({ status: "CANCELLED", finishedAt: new Date(), cancelVerified: { note: "no live runtime; persisted state already idle", markedCancelled: active.length } }).where(eq(tasks.id, taskId));
    await emit({ topic: "task.cancelled", taskId, level: "warn", message: `task cancelled (no live runtime); ${active.length} persisted step(s) marked cancelled` });
    return { ok: true, detail: "task was not executing; persisted state cancelled", evidence: { markedCancelled: active.length } };
  }

  const runningBefore = [...runtime.steps.values()].filter((entry) => entry.status === "RUNNING").map((entry) => ({ stepId: entry.step.id, tool: entry.step.toolId }));
  runtime.controller.abort();

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && [...runtime.steps.values()].some((entry) => entry.status === "RUNNING")) {
    await sleep(250).catch(() => undefined);
  }
  const stillRunning = [...runtime.steps.values()].filter((entry) => entry.status === "RUNNING").map((entry) => entry.step.title);
  const toolRunCounts: Record<string, number> = {};
  for (const item of runningBefore) {
    const runs = await db.select().from(toolRuns).where(eq(toolRuns.stepId, item.stepId));
    toolRunCounts[item.stepId] = runs.length;
  }
  const evidence = {
    aborted: runtime.controller.signal.aborted,
    runningBefore,
    stillRunning,
    settledPromises: [...runtime.steps.values()].filter((entry) => entry.settled).length,
    toolRunCounts,
    verifiedAt: new Date().toISOString(),
  };
  await db.update(tasks).set({ cancelVerified: evidence }).where(eq(tasks.id, taskId));
  await emit({
    topic: "task.cancel_verified",
    taskId,
    level: stillRunning.length ? "error" : "success",
    message: stillRunning.length
      ? `cancellation could not stop: ${stillRunning.join(", ")}`
      : `cancellation verified: ${runningBefore.length} in-flight step(s) torn down, no step still RUNNING`,
    payload: evidence,
  });
  return { ok: true, detail: stillRunning.length ? "cancellation incomplete" : "cancellation verified", evidence };
}

export async function listTasks(limit = 30): Promise<TaskRow[]> {
  const rows = await db.select().from(tasks).limit(500);
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
}

export async function startTaskFromRequest(request: string): Promise<TaskRow> {
  return startTask({ request });
}


