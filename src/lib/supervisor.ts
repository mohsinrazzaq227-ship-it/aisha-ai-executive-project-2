import fs from "node:fs";
import path from "node:path";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  agentStates,
  approvals,
  artifacts,
  events as eventsTable,
  planSteps,
  tasks,
  uploads as uploadsTable,
} from "@/db/schema";
import { AGENTS, agentSlot, getAgent } from "@/lib/agents";
import { emit, setAgentState } from "@/lib/events";
import { newId, parametersHash, sha256, issueApprovalToken, safeCompare } from "@/lib/ids";
import { logEvent } from "@/lib/logging";
import { planWalk, stationSlotNode, STATIONS, type StationId } from "@/lib/nav";
import { providerInventory } from "@/lib/providers";
import { buildPlan, type Plan, type PlannedStep } from "@/lib/planner";
import { ffmpegJobs } from "@/lib/tools/jobRegistry";
import { getHandler } from "@/lib/tools";
import { getTool, validateShellCommand } from "@/lib/tools/registry";
import { fail as toolFail, type ToolContext, type ToolResult } from "@/lib/tools/types";
import { ensureDir, relToRoot, roots, uniqueFilename } from "@/lib/workspace";

type Running = { controller: AbortController; startedAt: number };
const globalForSupervisor = globalThis as typeof globalThis & {
  __aiExecRunning?: Map<string, Running>;
  __aiExecAgentLocks?: Map<string, Promise<void>>;
};
const running: Map<string, Running> = globalForSupervisor.__aiExecRunning ?? new Map();
const agentLocks: Map<string, Promise<void>> = globalForSupervisor.__aiExecAgentLocks ?? new Map();
globalForSupervisor.__aiExecRunning = running;
globalForSupervisor.__aiExecAgentLocks = agentLocks;

const APPROVAL_TTL_MS = 15 * 60 * 1000;

function approvalSecret(): string {
  return process.env.APPROVAL_SECRET ?? `ai-executive-local-${roots().projectRoot}`;
}

function sleep(ms: number, controller: AbortController): Promise<void> {
  return new Promise((resolve) => {
    const chunks = Math.max(1, Math.ceil(ms / 200));
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += 200;
      if (controller.signal.aborted || elapsed >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, Math.min(200, chunks));
  });
}

async function acquireAgent(agentId: string, taskId: string): Promise<() => void> {
  const previous = agentLocks.get(agentId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  agentLocks.set(agentId, previous.then(() => current));
  await previous;
  return () => {
    release();
    if (agentLocks.get(agentId) === previous.then(() => current)) agentLocks.delete(agentId);
    void taskId;
  };
}

/* ------------------------------------------------------------------ */
/* Task creation                                                      */
/* ------------------------------------------------------------------ */

export type TaskCreateResult = {
  taskId: string;
  runId: string;
  plan: Plan;
  workDir: string;
};

export async function createTask(message: string, uploadIds: string[] = []): Promise<TaskCreateResult> {
  const r = ensureDir(roots().runsRoot) ? roots() : roots();
  const providers = await providerInventory();
  const ollama = providers.find((p) => p.id === "llm.ollama");
  const cloud = providers.find((p) => p.id === "llm.cloud");
  const llmEngine: Plan["engine"] = ollama?.status === "AVAILABLE" ? "ollama" : cloud?.status === "OPTIONAL_UNTESTED" ? "cloud" : "deterministic_local";
  const llmDetail =
    llmEngine === "ollama"
      ? `Planned with the deterministic local planner; section writing delegated to Ollama (${process.env.OLLAMA_MODEL ?? "llama3.1:8b"}).`
      : llmEngine === "cloud"
        ? "Deterministic local planner active; an explicitly enabled cloud model is used for prose only."
        : "Deterministic local planner (no language model configured). Intent parsing is rule-based and auditable — nothing silently falls back to a paid API.";

  const uploadHints = uploadIds.length
    ? (await db.select().from(uploadsTable).where(inArray(uploadsTable.id, uploadIds))).map((row) => ({ id: row.id, originalName: row.originalName, mime: row.mime }))
    : [];
  const plan = buildPlan({ message, uploads: uploadHints, llmEngine, llmDetail });

  const taskId = newId("tsk");
  const runId = newId("run");
  const workDir = ensureDir(path.join(r.runsRoot, runId));
  for (const dir of ["research", "script", "storyboard", "images", "audio", "captions", "renders", "validation", "logs", "handles", "extractions", "analysis", "email"]) {
    ensureDir(path.join(workDir, dir));
  }
  fs.writeFileSync(path.join(workDir, "request.json"), JSON.stringify({ message, uploadIds, createdAt: new Date().toISOString() }, null, 2));

  await db.insert(tasks).values({
    id: taskId,
    runId,
    title: plan.title,
    request: { message, uploadIds },
    intent: plan.intent,
    plannerEngine: plan.engine,
    status: "PLANNING",
    priority: 5,
    progress: 0,
    workDir,
  });

  const stepRows = plan.steps.map((step, index) => ({
    id: `${taskId}_s${String(index + 1).padStart(2, "0")}`,
    taskId,
    stepIndex: index,
    title: step.title,
    detail: step.detail,
    agentId: step.agentId,
    toolId: step.toolId,
    toolInput: step.toolInput,
    risk: step.risk,
    requiresApproval: step.requiresApproval,
    status: "PENDING" as const,
    dependsOn: step.dependsOn ?? [],
    parallel: step.parallel ?? false,
    resourceClass: step.resourceClass ?? "LIGHT",
  }));
  await db.insert(planSteps).values(stepRows);

  if (uploadIds.length > 0) {
    await db.update(uploadsTable).set({ taskId }).where(inArray(uploadsTable.id, uploadIds));
  }

  fs.writeFileSync(path.join(workDir, "plan.json"), JSON.stringify({ plan, steps: stepRows.map(({ toolInput, ...rest }) => rest), plannerDetail: llmDetail }, null, 2));
  fs.writeFileSync(path.join(workDir, "context.json"), JSON.stringify({ findings: {}, createdAt: new Date().toISOString() }, null, 2));

  await emit({
    ts: new Date().toISOString(),
    taskId,
    runId,
    agentId: "master_supervisor",
    type: "TASK_CREATED",
    message: `Task accepted: ${plan.title}`,
    data: { message, intent: plan.intent, plannerEngine: plan.engine, plannerDetail: llmDetail, uploads: uploadHints },
  });
  await setAgentState("master_supervisor", "PLANNING", {
    taskId,
    stationId: stationSlotNode("MASTER_SEAT", 0),
    message: `Planning: ${plan.title}`,
    mood: "FOCUSED",
  });
  await emit({
    ts: new Date().toISOString(),
    taskId,
    runId,
    agentId: "master_supervisor",
    type: "TASK_PLANNED",
    message: `Plan ready with ${plan.steps.length} steps. Risk classes: ${Array.from(new Set(plan.steps.map((s) => s.risk))).join(", ")}.`,
    data: {
      steps: plan.steps.map((s, index) => ({ index: index + 1, title: s.title, agent: getAgent(s.agentId).name, role: getAgent(s.agentId).role, tool: s.toolId, risk: s.risk, requiresApproval: s.requiresApproval })),
      notes: plan.notes,
      engine: plan.engine,
    },
  });
  await db.update(tasks).set({ status: "QUEUED", updatedAt: new Date() }).where(eq(tasks.id, taskId));

  void runTask(taskId);
  return { taskId, runId, plan, workDir };
}

/* ------------------------------------------------------------------ */
/* Input hydration from previous artifacts                            */
/* ------------------------------------------------------------------ */

type Findings = Record<string, unknown>;

function ctx_root_path(value: unknown, findings: Findings): string {
  if (typeof value === "string" && value.length > 0) return value;
  const report = findings.reportPath as string | undefined;
  const video = findings.videoPath as string | undefined;
  return report ?? video ?? "documents";
}

function hydrateInput(toolId: string, input: Record<string, unknown>, findings: Findings): Record<string, unknown> {
  const next = { ...input };
  const research = findings.research as { facts?: string[]; sources?: { title: string; url: string }[]; id?: string } | undefined;
  const script = findings.script as { id?: string; beats?: { narration: string; wordCount: number; beat: string }[] } | undefined;
  const storyboard = findings.storyboard as { id?: string; scenes?: { index: number }[] } | undefined;
  const brief = findings.brief as { id?: string } | undefined;
  const captions = findings.captions as { id?: string } | undefined;
  const audio = findings.audio as { id?: string } | undefined;
  const alignment = findings.alignment as { id?: string } | undefined;

  if ("scriptId" in next && !next.scriptId) next.scriptId = script?.id ?? "script";
  if ("storyboardId" in next && !next.storyboardId) next.storyboardId = storyboard?.id ?? "storyboard";
  if ("briefId" in next && !next.briefId) next.briefId = brief?.id ?? "brief";
  if ("captionId" in next && !next.captionId) next.captionId = captions?.id ?? "captions";
  if ("audioId" in next && !next.audioId) next.audioId = audio?.id ?? "audio";
  if ("alignmentId" in next && !next.alignmentId) next.alignmentId = alignment?.id ?? "alignment";

  if (toolId === "research.verify") {
    const claims = (script?.beats ?? []).slice(0, 12).map((b) => b.narration.slice(0, 240));
    next.claims = claims.length > 0 ? claims : (research?.facts ?? []).slice(0, 12).map((f) => f.slice(0, 240));
    next.sources = (research?.sources ?? []).map((s) => ({ title: s.title, url: s.url }));
  }
  if (toolId === "validation.ffprobe") {
    // The planner emits a placeholder: point the validator at the file this run really produced.
    if (!next.path) next.path = String(findings.videoPath ?? findings.reportPath ?? ctx_root_path(next.path, findings));
    if (!next.artifactId) next.artifactId = findings.videoArtifactId ?? findings.reportArtifactId ?? "";
  }
  if (toolId === "report.export") {
    const reportPath = findings.reportPath as string | undefined;
    if (reportPath) next.artifactPath = reportPath;
    if (!next.title) next.title = String((findings.brief as { topic?: string } | undefined)?.topic ?? "Report");
  }
  if (toolId === "artifact.register") {
    // The handler derives everything from the real run findings; ensure a path-shaped
    // parameter exists so the resolver never trips over an empty placeholder.
    next.path = String(ctx_root_path(next.path, findings));
    next.kind = String(next.kind || "artifact");
  }
  if (toolId === "report.write") {
    const sections = (next.sections as unknown[] | undefined) ?? [];
    if (sections.length === 0) {
      const facts = research?.facts ?? [];
      const sources = research?.sources ?? [];
      const analysis = findings.docAnalysis as { words?: number; sentences?: number; urls?: string[]; topTerms?: { term: string; count: number }[]; keyPhrases?: { phrase: string; count: number }[] } | undefined;
      const extractedDocs = (findings.documents as { name: string; engine: string; words: number; pages?: number }[] | undefined) ?? [];
      next.sections = [
        {
          heading: "Executive summary",
          body:
            facts.length > 0
              ? `This report is built from ${sources.length} live sources retrieved during this task. ${facts.length} verifiable statements were extracted directly from those records. Every claim below traces to a source listed at the end of this document.`
              : analysis
                ? `This report analyses a local document: ${analysis.words ?? 0} words across ${analysis.sentences ?? 0} sentences.`
                : "No research evidence was retrieved for this task, so this report states that plainly instead of inventing content.",
          bullets: facts.slice(0, 6),
        },
        ...(analysis
          ? [
              { heading: "Document analysis", body: analysis.keyPhrases?.length ? `Dominant phrases: ${analysis.keyPhrases.slice(0, 6).map((k) => k.phrase).join(", ")}.` : "Phrase analysis produced no repeated multi-word terms.", bullets: (analysis.topTerms ?? []).slice(0, 8).map((t) => `${t.term} — ${t.count} occurrences`) },
            ]
          : []),
        ...(extractedDocs.length > 0 ? [{ heading: "Files processed", body: "Extraction provenance:", bullets: extractedDocs.map((d) => `${d.name} — ${d.words} words via ${d.engine}${d.pages ? `, ${d.pages} pages` : ""}`) }] : []),
        {
          heading: "Sources reviewed",
          body: sources.length > 0 ? `${sources.length} sources were retrieved and are listed in the provenance section below, with their original URLs.` : "No external sources were used.",
          bullets: sources.slice(0, 12).map((s) => `${s.title} — ${s.url}`),
        },
        {
          heading: "Limitations",
          body: "This report was produced locally by AI-EXECUTIVE. Verification coverage is reported per claim; anything not directly supported by a source record is labelled as such rather than smoothed over.",
        },
      ];
      if ((next.sources as unknown[] | undefined) === undefined || (next.sources as unknown[]).length === 0) {
        next.sources = research?.sources ?? [];
      }
    }
  }
  if (toolId === "email.draft" || toolId === "email.send") {
    if (!next.to || next.to === "me") next.to = process.env.EMAIL_DEFAULT_TO ?? String(next.to ?? "me");
    const reportPath = findings.reportPath as string | undefined;
    const videoPath = findings.videoPath as string | undefined;
    const produced = [reportPath, videoPath].filter(Boolean) as string[];
    if (!next.body || String(next.body).trim().length === 0) {
      const facts = research?.facts ?? [];
      next.body = [
        `Requested work summary — task ${String(findings.taskId ?? "")}`,
        "",
        facts.length > 0 ? `Verified statements gathered:\n${facts.slice(0, 5).map((f) => `- ${f}`).join("\n")}` : "No research evidence was gathered for this task.",
        produced.length > 0 ? `\nAttached/generated locally:\n${produced.map((p) => `- ${relToRoot(p)}`).join("\n")}` : "",
        "",
        "Produced locally by AI-EXECUTIVE. This message was sent only after your explicit approval.",
      ].join("\n");
    }
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Approval handling                                                  */
/* ------------------------------------------------------------------ */

function describeTarget(toolId: string, input: Record<string, unknown>): string {
  if (typeof input.command === "string") return `program: ${String(input.command).split(/\s+/)[0]} · interpreter: ${process.platform === "win32" ? "PowerShell" : "bash"}`;
  if (typeof input.path === "string") return String(input.path);
  if (typeof input.destination === "string") return String(input.destination);
  if (typeof input.to === "string") return `recipient: ${String(input.to)}`;
  if (Array.isArray(input.paths)) return (input.paths as string[]).join(", ");
  if (typeof input.target === "string") return String(input.target);
  return toolId;
}

async function createApprovalForStep(taskId: string, runId: string, stepRow: typeof planSteps.$inferSelect, reason: string): Promise<string> {
  const action = { toolId: stepRow.toolId, parameters: stepRow.toolInput ?? {}, taskId, stepId: stepRow.id, agentId: stepRow.agentId };
  const hash = parametersHash(action);
  const approvalId = newId("apr");
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
  await db.insert(approvals).values({
    id: approvalId,
    taskId,
    stepId: stepRow.id,
    agentId: stepRow.agentId,
    toolId: stepRow.toolId ?? "unknown",
    action: (stepRow.toolInput ?? {}) as Record<string, unknown>,
    risk: stepRow.risk,
    parametersHash: hash,
    reason,
    target: describeTarget(stepRow.toolId ?? "", stepRow.toolInput ?? {}),
    status: "PENDING",
    expiresAt,
  });
  await db.update(planSteps).set({ status: "WAITING_APPROVAL", approvalId }).where(eq(planSteps.id, stepRow.id));
  await db.update(tasks).set({ status: "WAITING_APPROVAL", currentStepId: stepRow.id, currentAgentId: stepRow.agentId, updatedAt: new Date() }).where(eq(tasks.id, taskId));
  await setAgentState(stepRow.agentId, "WAITING_APPROVAL", {
    taskId,
    stepId: stepRow.id,
    message: `Waiting for your approval: ${stepRow.title}`,
    mood: "WAITING",
  });
  await emit({
    ts: new Date().toISOString(),
    taskId,
    runId,
    agentId: stepRow.agentId,
    type: "APPROVAL_REQUESTED",
    message: `Approval required (${stepRow.risk}): ${stepRow.title}`,
    severity: stepRow.risk === "HIGH" ? "warn" : "info",
    data: {
      approvalId,
      risk: stepRow.risk,
      agent: getAgent(stepRow.agentId).name,
      role: getAgent(stepRow.agentId).role,
      tool: stepRow.toolId,
      toolLabel: getTool(stepRow.toolId ?? "").approvalLabel,
      action: stepRow.toolInput ?? {},
      parametersHash: hash,
      target: describeTarget(stepRow.toolId ?? "", stepRow.toolInput ?? {}),
      reason,
      expiresAt: expiresAt.toISOString(),
    },
  });
  fs.appendFileSync(
    path.join(roots().runsRoot, runId, "approvals.json"),
    `${JSON.stringify({ requestedAt: new Date().toISOString(), approvalId, stepId: stepRow.id, toolId: stepRow.toolId, risk: stepRow.risk, parametersHash: hash, action: stepRow.toolInput, reason }, null, 2)}\n`,
  );
  await logEvent("security", `Approval requested for ${stepRow.toolId} (${stepRow.risk})`, { taskId, data: { approvalId, hash } });
  return approvalId;
}

async function findExecutableApproval(taskId: string, stepRow: typeof planSteps.$inferSelect, hash: string) {
  const candidates = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.taskId, taskId), eq(approvals.parametersHash, hash)))
    .orderBy(desc(approvals.createdAt));
  const now = Date.now();
  return (
    candidates.find((row) => (row.status === "APPROVED_ONCE" || row.status === "APPROVED_SESSION") && row.expiresAt.getTime() > now) ?? null
  );
}

export async function decideApproval(
  approvalId: string,
  decision: "APPROVE_ONCE" | "APPROVE_SESSION" | "DENY" | "MODIFY",
  options: { note?: string; parameters?: Record<string, unknown> } = {},
): Promise<{ ok: boolean; message: string; invalidated?: boolean }> {
  const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
  if (!approval) return { ok: false, message: "Approval request not found." };
  if (approval.status !== "PENDING") return { ok: false, message: `This request was already decided (${approval.status}).` };
  if (approval.expiresAt.getTime() < Date.now()) {
    await db.update(approvals).set({ status: "EXPIRED", decidedAt: new Date() }).where(eq(approvals.id, approvalId));
    await emit({ ts: new Date().toISOString(), taskId: approval.taskId, agentId: approval.agentId, type: "APPROVAL_INVALIDATED", message: `Approval expired before a decision: ${approval.toolId}`, severity: "warn", data: { approvalId } });
    return { ok: false, message: "This approval request has expired. The task will ask again when you resume it." };
  }
  const [stepRow] = await db.select().from(planSteps).where(eq(planSteps.id, approval.stepId)).limit(1);
  if (!stepRow) return { ok: false, message: "The plan step for this approval no longer exists." };
  const [, runRow] = [null, (await db.select().from(tasks).where(eq(tasks.id, approval.taskId)).limit(1))[0]];

  // Parameter integrity check: the action being approved must be exactly the action on the step.
  const currentAction = { toolId: stepRow.toolId, parameters: stepRow.toolInput ?? {}, taskId: approval.taskId, stepId: stepRow.id, agentId: stepRow.agentId };
  const currentHash = parametersHash(currentAction);
  if (currentHash !== approval.parametersHash && decision !== "MODIFY") {
    await db.update(approvals).set({ status: "INVALIDATED", decidedAt: new Date(), note: "Parameters changed since the request" }).where(eq(approvals.id, approvalId));
    await emit({
      ts: new Date().toISOString(),
      taskId: approval.taskId,
      agentId: approval.agentId,
      type: "APPROVAL_INVALIDATED",
      message: `TOKEN INVALID — the step parameters changed after approval was requested (${approval.toolId}). A new approval will be requested for the exact new action.`,
      severity: "warn",
      data: { approvalId, approvedHash: approval.parametersHash, currentHash },
    });
    await db.update(planSteps).set({ status: "PENDING" }).where(eq(planSteps.id, stepRow.id));
    return { ok: false, invalidated: true, message: "TOKEN INVALID: the parameters changed. The task will request approval again for the exact new action." };
  }

  if (decision === "MODIFY") {
    if (!options.parameters) return { ok: false, message: "MODIFY requires replacement parameters." };
    const merged = { ...(stepRow.toolInput ?? {}), ...options.parameters };
    await db.update(approvals).set({ status: "INVALIDATED", decidedAt: new Date(), note: "User modified parameters" }).where(eq(approvals.id, approvalId));
    await db.update(planSteps).set({ toolInput: merged, status: "PENDING", approvalId: null }).where(eq(planSteps.id, stepRow.id));
    await emit({
      ts: new Date().toISOString(),
      taskId: approval.taskId,
      agentId: approval.agentId,
      type: "APPROVAL_INVALIDATED",
      message: `Parameters modified by the user — the old approval is void and a new approval will be requested for the edited action.`,
      severity: "warn",
      data: { approvalId, merged },
    });
    if (runRow) void resumeTask(approval.taskId);
    return { ok: true, message: "Parameters replaced. The task will request approval again for the edited action." };
  }

  if (decision === "DENY") {
    await db.update(approvals).set({ status: "DENIED", decision: "DENY", decidedAt: new Date(), note: options.note ?? null }).where(eq(approvals.id, approvalId));
    await db.update(planSteps).set({ status: "FAILED", error: "Denied by the user — the action was never executed.", finishedAt: new Date() }).where(eq(planSteps.id, stepRow.id));
    if (runRow) {
      await db
        .update(tasks)
        .set({ status: "FAILED", error: `Approval denied by the user for ${approval.toolId}. Nothing was executed.`, finishedAt: new Date(), updatedAt: new Date(), progress: runRow.progress })
        .where(eq(tasks.id, approval.taskId));
    }
    await setAgentState(approval.agentId, "ERROR", { taskId: approval.taskId, stepId: stepRow.id, message: "Action denied by the user — nothing executed.", mood: "BLOCKED" });
    await emit({
      ts: new Date().toISOString(),
      taskId: approval.taskId,
      agentId: approval.agentId,
      type: "APPROVAL_DENIED",
      message: `Denied by the user: ${approval.toolId}. The action was not executed and nothing changed on your system.`,
      severity: "warn",
      data: { approvalId },
    });
    return { ok: true, message: "Denied. Nothing was executed." };
  }

  const status = decision === "APPROVE_SESSION" ? "APPROVED_SESSION" : "APPROVED_ONCE";
  const tokenHash = issueApprovalToken(approval.parametersHash, approval.id, approvalSecret());
  // The step was parked in WAITING_APPROVAL; put it back in the runnable set so the
  // scheduler can pick it up again with the verified token.
  await db.update(planSteps).set({ status: "PENDING", error: null }).where(and(eq(planSteps.id, approval.stepId), eq(planSteps.status, "WAITING_APPROVAL")));
  await db.update(approvals).set({ status, decision, scope: decision === "APPROVE_SESSION" ? "SESSION" : "ONCE", tokenHash, decidedAt: new Date(), note: options.note ?? null }).where(eq(approvals.id, approvalId));
  await emit({
    ts: new Date().toISOString(),
    taskId: approval.taskId,
    agentId: approval.agentId,
    type: "APPROVAL_GRANTED",
    message: `${decision === "APPROVE_SESSION" ? "Approved for this session" : "Approved once"}: ${approval.toolId}`,
    severity: "success",
    data: { approvalId, scope: decision === "APPROVE_SESSION" ? "SESSION" : "ONCE", parametersHash: approval.parametersHash, tokenIssued: true },
  });
  await logEvent("security", `Approval granted (${decision}) for ${approval.toolId}`, { taskId: approval.taskId, data: { approvalId, hash: approval.parametersHash } });
  void resumeTask(approval.taskId);
  return { ok: true, message: "Approved. Execution continues now." };
}

/* ------------------------------------------------------------------ */
/* Execution loop                                                     */
/* ------------------------------------------------------------------ */

function loadFindings(workDir: string): Findings {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(workDir, "context.json"), "utf8")) as { findings?: Findings };
    return raw.findings ?? {};
  } catch {
    return {};
  }
}

function saveFindings(workDir: string, findings: Findings): void {
  fs.writeFileSync(path.join(workDir, "context.json"), JSON.stringify({ findings, updatedAt: new Date().toISOString() }, null, 2));
}

async function handleWrite(workDir: string, handleId: string, value: unknown): Promise<string> {
  const dir = ensureDir(path.join(workDir, "handles"));
  fs.writeFileSync(path.join(dir, `${handleId}.json`), JSON.stringify(value, null, 2));
  return handleId;
}

async function handleLoad<T>(workDir: string, handleId: string): Promise<T | null> {
  try {
    return JSON.parse(fs.readFileSync(path.join(workDir, "handles", `${handleId}.json`), "utf8")) as T;
  } catch {
    return null;
  }
}

async function markArtifacts(taskId: string, stepId: string, agentId: string, result: ToolResult, findings: Findings): Promise<void> {
  for (const artifact of result.artifacts ?? []) {
    let size = 0;
    try {
      size = fs.statSync(artifact.absPath).size;
    } catch {
      size = 0;
    }
    const id = newId("art");
    try {
      await db.insert(artifacts).values({
        id,
        taskId,
        stepId,
        agentId,
        kind: artifact.kind,
        name: artifact.name,
        relPath: relToRoot(artifact.absPath),
        mime: artifact.mime ?? "application/octet-stream",
        size,
        meta: { ...(artifact.meta ?? {}), absPath: artifact.absPath },
        validated: artifact.validated ?? false,
      });
      if (artifact.kind === "video") findings.videoPath = artifact.absPath;
      if (artifact.kind === "report") findings.reportPath = artifact.absPath;
      findings.artifactPaths = { ...((findings.artifactPaths as Record<string, string>) ?? {}), [id]: artifact.absPath };
    } catch (error) {
      await logEvent("errors", `Artifact registration failed: ${(error as Error).message}`, { level: "error", taskId, data: { artifact } });
    }
    await emit({
      ts: new Date().toISOString(),
      taskId,
      agentId,
      type: artifact.kind === "video" ? "VIDEO_VALIDATED" : "ARTIFACT_CREATED",
      message: `${artifact.kind}: ${artifact.name} (${size > 0 ? `${(size / 1024).toFixed(0)} KB` : "empty"})${artifact.validated ? " · validated" : ""}`,
      severity: "success",
      data: { id, kind: artifact.kind, name: artifact.name, path: artifact.absPath, size, validated: artifact.validated ?? false, meta: artifact.meta ?? {} },
    });
  }
}

async function executeStep(
  taskRow: typeof tasks.$inferSelect,
  stepRow: typeof planSteps.$inferSelect,
  findings: Findings,
  controller: AbortController,
): Promise<ToolResult> {
  const toolId = stepRow.toolId ?? "";
  const tool = getTool(toolId);
  const handler = getHandler(toolId);
  const agent = getAgent(stepRow.agentId);

  // Host requirement gate — honest refusals instead of pretending.
  if (tool.hostRequirement === "windows" && process.platform !== "win32") {
    return toolFail(
      `${tool.approvalLabel} requires a Windows host. This environment is ${process.platform}, so the action was not attempted and nothing simulated it.`,
      "HOST_REQUIREMENT_NOT_MET",
      { hostRequirement: tool.hostRequirement, platform: process.platform },
    );
  }
  if (!handler) return toolFail(`Tool "${toolId}" has no handler installed.`, "HANDLER_MISSING");

  if (toolId === "shell.execute") {
    const decision = validateShellCommand(String((stepRow.toolInput ?? {}).command ?? ""), loadConfig().allowedCommands);
    if (!decision.ok) return toolFail(`Execution refused by the command validator: ${decision.reason}`, "VALIDATOR_BLOCKED");
  }

  const stepController = new AbortController();
  const onAbort = () => stepController.abort();
  controller.signal.addEventListener("abort", onAbort, { once: true });

  const ctx: ToolContext = {
    taskId: taskRow.id,
    runId: taskRow.runId,
    stepId: stepRow.id,
    agentId: stepRow.agentId,
    runDir: taskRow.workDir,
    input: hydrateInput(toolId, stepRow.toolInput ?? {}, findings),
    signal: stepController.signal,
    progress: async (message, data) => {
      await emit({
        ts: new Date().toISOString(),
        taskId: taskRow.id,
        runId: taskRow.runId,
        agentId: stepRow.agentId,
        type: /render|frame|encode|caption/i.test(message) ? "VIDEO_RENDER_PROGRESS" : "TOOL_PROGRESS",
        message,
        data: { stepId: stepRow.id, toolId, ...(data ?? {}) },
      });
    },
    handle: (handleId, value) => handleWrite(taskRow.workDir, handleId, value),
    loadHandle: <T,>(handleId: string) => handleLoad<T>(taskRow.workDir, handleId),
    findings,
    providers: [],
    workspace: roots(),
    allowedCommands: loadConfig().allowedCommands,
    tenant: {
      cloudLlmEnabled: process.env.AI_EXECUTIVE_ENABLE_CLOUD_LLM === "true",
      ollamaUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
      ollamaModel: process.env.OLLAMA_MODEL ?? "llama3.1:8b",
      whisperUrl: process.env.WHISPER_URL,
      ttsUrl: process.env.TTS_URL,
    },
  };

  await emit({
    ts: new Date().toISOString(),
    taskId: taskRow.id,
    runId: taskRow.runId,
    agentId: stepRow.agentId,
    type: "TOOL_STARTED",
    message: `${agent.name} started ${tool.approvalLabel} (${toolId})`,
    data: { stepId: stepRow.id, toolId, risk: tool.risk, parameters: redactParams(ctx.input) },
  });

  let result: ToolResult;
  let timedOut = false;
  try {
    result = await Promise.race([
      handler(ctx),
      new Promise<ToolResult>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          stepController.abort();
          resolve(toolFail(`Tool "${toolId}" exceeded its ${tool.timeoutMs} ms timeout and was aborted.`, "TIMEOUT"));
        }, tool.timeoutMs);
      }),
    ]);
  } catch (error) {
    result = toolFail(`Tool execution threw: ${(error as Error).message}`, "TOOL_THREW", { stack: (error as Error).stack?.slice(0, 1200) });
  } finally {
    controller.signal.removeEventListener("abort", onAbort);
  }
  if (timedOut) await logEvent("errors", `Tool timeout: ${toolId}`, { level: "error", taskId: taskRow.id, agentId: stepRow.agentId });
  return result;
}

function redactParams(input: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (/password|secret|token|key/i.test(key)) clone[key] = "[REDACTED]";
    else if (typeof value === "string" && value.length > 400) clone[key] = `${value.slice(0, 400)}…`;
    else clone[key] = value;
  }
  return clone;
}

export type Config = { allowedCommands: string[]; autonomy: { maxConcurrentTasks: number; walkRealism: boolean } };

export function loadConfig(): Config {
  const fallback: Config = { allowedCommands: [], autonomy: { maxConcurrentTasks: 6, walkRealism: true } };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(roots().projectRoot, "config", "app.json"), "utf8")) as Partial<Config>;
    return {
      allowedCommands: raw.allowedCommands ?? [],
      autonomy: { maxConcurrentTasks: raw.autonomy?.maxConcurrentTasks ?? 6, walkRealism: raw.autonomy?.walkRealism ?? true },
    };
  } catch {
    return fallback;
  }
}

async function walkAgent(agentId: string, toNode: string, taskId: string, runId: string, data: Record<string, unknown> = {}): Promise<void> {
  const [agentRow] = await db.select().from(agentStates).where(eq(agentStates.agentId, agentId)).limit(1);
  const config = loadConfig();
  const from = agentRow?.stationId ?? stationSlotNode(getAgent(agentId).station, agentSlot(agentId));
  const walk = planWalk(from, toNode);
  const walkMs = config.autonomy.walkRealism ? walk.walkMs : Math.min(900, walk.walkMs);
  await db
    .insert(agentStates)
    .values({ agentId, state: "WALKING", taskId, stationId: toNode, updatedAt: new Date() })
    .onConflictDoUpdate({ target: agentStates.agentId, set: { state: "WALKING", taskId, stationId: toNode, updatedAt: new Date() } });
  await emit({
    ts: new Date().toISOString(),
    taskId,
    runId,
    agentId,
    type: "AGENT_WALKING",
    message: `${getAgent(agentId).name} is walking to ${toNode}`,
    data: { path: walk.path, nodes: walk.nodes, walkMs, from, to: toNode, distance: Number(walk.distance.toFixed(2)), failed: walk.failed, ...data },
  });
  const controller = running.get(taskId)?.controller ?? new AbortController();
  await sleep(walkMs, controller);
}

type StepOutcome = "DONE" | "APPROVAL_WAIT" | "FAILED" | "CANCELLED" | "PAUSED" | "SKIPPED";

/**
 * Execute one node of the task graph: assignment, approval gate (verified token),
 * physical walk to the station, real tool execution, honest error handling,
 * payload handoff back to the supervisor and state reset.
 */
async function executeGraphStep(
  taskRow: typeof tasks.$inferSelect,
  current: typeof planSteps.$inferSelect,
  controller: AbortController,
): Promise<StepOutcome> {
  const taskId = taskRow.id;
  const runId = taskRow.runId;
  const findings = loadFindings(taskRow.workDir);
  const tool = getTool(current.toolId ?? "");
  const agent = getAgent(current.agentId);
  const [allSteps, latestTask] = await Promise.all([
    db.select().from(planSteps).where(eq(planSteps.taskId, taskId)),
    db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1),
  ]);
  const total = allSteps.length;
  if (latestTask[0]?.controlFlag === "CANCEL") return "CANCELLED";
  if (latestTask[0]?.controlFlag === "PAUSE") return "PAUSED";

  await db.update(planSteps).set({ status: "RUNNING", startedAt: new Date(), attempts: current.attempts + 1 }).where(eq(planSteps.id, current.id));
  await db.update(tasks).set({ currentStepId: current.id, currentAgentId: current.agentId, updatedAt: new Date() }).where(eq(tasks.id, taskId));
  await emit({
    ts: new Date().toISOString(),
    taskId,
    runId,
    agentId: current.agentId,
    type: "AGENT_ASSIGNED",
    message: `${agent.name} (${agent.role}) assigned: ${current.title}`,
    data: {
      stepId: current.id,
      stepIndex: current.stepIndex,
      toolId: current.toolId,
      risk: current.risk,
      approvalRequired: current.requiresApproval,
      detail: current.detail,
      dependsOn: current.dependsOn,
      resourceClass: current.resourceClass,
      parallel: current.parallel,
    },
  });

  // ---- Approval gate: verified token, never a UI flag -----------------------
  if (current.requiresApproval) {
    const action = { toolId: current.toolId, parameters: current.toolInput ?? {}, taskId, stepId: current.id, agentId: current.agentId };
    const hash = parametersHash(action);
    const approved = await findExecutableApproval(taskId, current, hash);
    if (!approved) {
      await createApprovalForStep(taskId, runId, current, current.detail ?? "This action changes state outside the application, so it needs your explicit approval.");
      return "APPROVAL_WAIT";
    }
    const expected = issueApprovalToken(approved.parametersHash, approved.id, approvalSecret());
    if (!approved.tokenHash || !safeCompare(approved.tokenHash, expected)) {
      await db.update(approvals).set({ status: "INVALIDATED", note: "Token verification failed" }).where(eq(approvals.id, approved.id));
      await db.update(planSteps).set({ status: "PENDING", approvalId: null }).where(eq(planSteps.id, current.id));
      await emit({
        ts: new Date().toISOString(),
        taskId,
        runId,
        agentId: current.agentId,
        type: "APPROVAL_INVALIDATED",
        message: "TOKEN INVALID — the stored approval token did not verify against this exact action. Approval will be requested again.",
        severity: "warn",
        data: { approvalId: approved.id },
      });
      return "APPROVAL_WAIT";
    }
    findings.approvedParametersHash = hash;
  }

  const homeNode = stationSlotNode(agent.station, agentSlot(agent.id));
  const fromStation = current.resourceClass === "HEAVY" ? STATIONS.MEDIA_DESK.id : agent.station;
  const walkTarget = stationSlotNode(fromStation, agentSlot(agent.id));
  if (current.agentId !== "master_supervisor") {
    await walkAgent(current.agentId, walkTarget, taskId, runId, { phase: "to-station", carrying: null, heavy: current.resourceClass === "HEAVY" });
  }
  await setAgentState(current.agentId, "WORKING", { taskId, stepId: current.id, stationId: walkTarget, message: `${current.title} — ${tool.approvalLabel}`, mood: "WORKING" });
  await db
    .update(tasks)
    .set({ status: "RUNNING", progress: Math.round((allSteps.filter((step) => step.status === "COMPLETED").length / Math.max(1, total)) * 100), updatedAt: new Date() })
    .where(eq(tasks.id, taskId));

  const releaseAgent = await acquireAgent(current.agentId, taskId);
  let result: ToolResult;
  try {
    result = await executeStep(taskRow, current, findings, controller);
    if (!result.ok && ["research.search", "browser.fetch", "browser.navigate"].includes(current.toolId ?? "") && !controller.signal.aborted) {
      await emit({ ts: new Date().toISOString(), taskId, runId, agentId: current.agentId, type: "TOOL_PROGRESS", message: `Retrying ${current.toolId} once after a transient failure.`, data: { error: result.error } });
      result = await executeStep(taskRow, current, findings, controller);
    }
  } finally {
    releaseAgent();
  }

  if (!result.ok) {
    await db.update(planSteps).set({ status: "FAILED", error: result.error ?? result.summary, output: { summary: result.summary, ...(result.output ?? {}) }, finishedAt: new Date() }).where(eq(planSteps.id, current.id));
    await markArtifacts(taskId, current.id, current.agentId, result, findings);
    saveFindings(taskRow.workDir, findings);
    await emit({
      ts: new Date().toISOString(),
      taskId,
      runId,
      agentId: current.agentId,
      type: "TOOL_FAILED",
      message: `${agent.name} hit an error in ${current.title}: ${result.error ?? result.summary}`,
      severity: "error",
      data: { stepId: current.id, toolId: current.toolId, diagnostics: result.diagnostics ?? {}, summary: result.summary, recovery: "Retry resets this step to PENDING so the task resumes from the first incomplete node." },
    });
    await setAgentState(current.agentId, "ERROR", { taskId, stepId: current.id, message: result.error ?? "Tool error", mood: "ERROR" });
    await db
      .update(tasks)
      .set({ status: "FAILED", error: `${current.title} failed: ${result.error ?? result.summary}`, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(tasks.id, taskId));
    await writeRunFiles(taskRow, findings);
    await emit({
      ts: new Date().toISOString(),
      taskId,
      runId,
      agentId: "master_supervisor",
      type: "SUPERVISOR_MESSAGE",
      message: `Task failed: ${result.error ?? result.summary}. No result was faked — you can retry, change the approach, or cancel.`,
      severity: "error",
      data: { failedStep: current.id, retryAvailable: true },
    });
    return "FAILED";
  }

  await db
    .update(planSteps)
    .set({ status: "COMPLETED", output: { summary: result.summary, agentMessage: result.agentMessage, ...(result.output ?? {}) }, error: null, finishedAt: new Date() })
    .where(eq(planSteps.id, current.id));
  await markArtifacts(taskId, current.id, current.agentId, result, findings);
  saveFindings(taskRow.workDir, findings);
  await emit({
    ts: new Date().toISOString(),
    taskId,
    runId,
    agentId: current.agentId,
    type: "TOOL_COMPLETED",
    message: `${current.title} complete: ${result.summary.slice(0, 300)}`,
    severity: "success",
    data: { stepId: current.id, toolId: current.toolId, summary: result.summary, output: redactParams(result.output ?? {}) },
  });
  if (result.agentMessage) {
    await setAgentState(current.agentId, "SPEAKING", { taskId, stepId: current.id, stationId: walkTarget, message: result.agentMessage.slice(0, 400), mood: "REPORTING" });
    const speakingController = running.get(taskId)?.controller ?? controller;
    await sleep(Math.min(2400, 800 + result.agentMessage.length * 10), speakingController);
  }
  await setAgentState(current.agentId, "COMPLETED", { taskId, stepId: current.id, stationId: walkTarget, message: `${current.title} complete`, mood: "SATISFIED" });

  const wantsHandoff = (result.artifacts?.length ?? 0) > 0 || Boolean(result.output?.handle);
  if (wantsHandoff && current.agentId !== "master_supervisor") {
    const payload = {
      kind: result.artifacts?.find((artifact) => ["report", "video", "script", "research", "storyboard", "screenshot", "extraction"].includes(artifact.kind))?.kind ?? "result",
      name: result.artifacts?.[0]?.name ?? current.title,
      summary: result.summary.slice(0, 240),
      artifacts: result.artifacts?.map((artifact) => artifact.name) ?? [],
    };
    await emit({
      ts: new Date().toISOString(),
      taskId,
      runId,
      agentId: current.agentId,
      type: "AGENT_STATE",
      message: `${agent.name} picked up the ${payload.kind} payload.`,
      data: { state: "CARRYING", payload, stepId: current.id },
    });
    await walkAgent(current.agentId, STATIONS.MASTER_SEAT.entrance, taskId, runId, { phase: "handoff", carrying: payload });
    await setAgentState(current.agentId, "HANDOFF", { taskId, stepId: current.id, stationId: STATIONS.MASTER_SEAT.entrance, message: `Handing over: ${payload.name}`, mood: "HANDOFF" });
    await setAgentState("master_supervisor", "RECEIVING", { taskId, stepId: current.id, stationId: stationSlotNode("MASTER_SEAT", 0), message: `Receiving ${payload.name} from ${agent.name}`, mood: "RECEIVING" });
    await emit({
      ts: new Date().toISOString(),
      taskId,
      runId,
      agentId: current.agentId,
      type: "AGENT_HANDOFF",
      message: `${agent.name} handed "${payload.name}" to the Master Supervisor.`,
      severity: "success",
      data: { payload, stepId: current.id, artifacts: payload.artifacts },
    });
    const handoffController = running.get(taskId)?.controller ?? controller;
    await sleep(1000, handoffController);
    await emit({
      ts: new Date().toISOString(),
      taskId,
      runId,
      agentId: "master_supervisor",
      type: "AGENT_RECEIVING",
      message: `Master Supervisor accepted the payload from ${agent.name}.`,
      data: { payload, stepId: current.id },
    });
    await walkAgent(current.agentId, homeNode, taskId, runId, { phase: "return", carrying: null });
  }
  await setAgentState(current.agentId, "IDLE", { taskId: null, stepId: null, stationId: homeNode, message: "Idle at station", mood: "CALM" });
  return "DONE";
}

async function runTask(taskId: string): Promise<void> {
  const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!taskRow) return;
  if (running.has(taskId)) return;
  const controller = new AbortController();
  running.set(taskId, { controller, startedAt: Date.now() });
  const runId = taskRow.runId;
  const findings = loadFindings(taskRow.workDir);

  try {
    await db.update(tasks).set({ status: "RUNNING", startedAt: taskRow.startedAt ?? new Date(), updatedAt: new Date() }).where(eq(tasks.id, taskId));

    const allSteps = await db.select().from(planSteps).where(eq(planSteps.taskId, taskId)).orderBy(asc(planSteps.stepIndex));
    const releaseLock = await acquireAgent("master_supervisor", taskId);
    const maxParallel = Math.max(1, loadConfig().autonomy.maxConcurrentTasks ?? 2);
    try {
      let wave = 0;
      while (wave < 60) {
        wave += 1;
        const [freshTask] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
        if (!freshTask) return;
        if (freshTask.controlFlag === "CANCEL") {
          await finalizeCancelled(freshTask, controller);
          return;
        }
        if (freshTask.controlFlag === "PAUSE") {
          await db.update(tasks).set({ status: "PAUSED", controlFlag: null, updatedAt: new Date() }).where(eq(tasks.id, taskId));
          await emit({ ts: new Date().toISOString(), taskId, runId, agentId: "master_supervisor", type: "TASK_STATUS", message: "Task paused by the user at a step boundary.", severity: "warn" });
          return;
        }

        const steps = await db.select().from(planSteps).where(eq(planSteps.taskId, taskId)).orderBy(asc(planSteps.stepIndex));
        const completedIndexes = new Set(steps.filter((step) => step.status === "COMPLETED" || step.status === "SKIPPED").map((step) => step.stepIndex));
        const unfinished = steps.filter((step) => step.status === "PENDING" || step.status === "RUNNING" || step.status === "WAITING_APPROVAL");
        if (unfinished.length === 0) break;

        const ready = steps.filter((step) => step.status === "PENDING" && (step.dependsOn ?? []).every((dependency) => completedIndexes.has(dependency)));
        if (ready.length === 0) {
          // Nothing is runnable. Either the task is genuinely waiting on the human, or an
          // upstream node can never complete. Never skip work silently.
          const waiting = steps.filter((step) => step.status === "WAITING_APPROVAL");
          if (waiting.length > 0) {
            await db.update(tasks).set({ status: "WAITING_APPROVAL", updatedAt: new Date() }).where(eq(tasks.id, taskId));
            await emit({
              ts: new Date().toISOString(),
              taskId,
              runId,
              agentId: "master_supervisor",
              type: "TASK_STATUS",
              message: `Task is waiting for your approval decision (${waiting.map((step) => step.title).join(", ")}). Nothing downstream runs until you decide.`,
              severity: "warn",
            });
            return;
          }
          const blocked = steps.filter((step) => step.status === "PENDING");
          const terminalFailures = steps.filter((step) => ["FAILED", "CANCELLED"].includes(step.status));
          for (const step of blocked) {
            await db
              .update(planSteps)
              .set({ status: "FAILED", error: `Not executed: upstream dependency incomplete (${terminalFailures.map((s) => `step ${s.stepIndex + 1} ${s.status}`).join(", ") || "dependency unresolved"}).`, finishedAt: new Date() })
              .where(eq(planSteps.id, step.id));
          }
          await emit({
            ts: new Date().toISOString(),
            taskId,
            runId,
            agentId: "master_supervisor",
            type: "TOOL_FAILED",
            message: `${blocked.length} step(s) could not run because an upstream dependency did not complete. Reported as failure, not as success.`,
            severity: "error",
            data: { dependencyState: steps.map((step) => ({ step: step.stepIndex + 1, status: step.status })) },
          });
          await db
            .update(tasks)
            .set({ status: "FAILED", error: `Task could not complete: ${blocked.length} downstream step(s) were blocked by an incomplete dependency.`, finishedAt: new Date(), updatedAt: new Date() })
            .where(eq(tasks.id, taskId));
          await writeRunFiles(taskRow, loadFindings(taskRow.workDir));
          return;
        }

        // Resource-aware scheduling: heavy stages (render/encode/narrate) run alone;
        // cheap stages run concurrently up to the configured limit.
        const heavy = ready.find((step) => step.resourceClass === "HEAVY");
        const batch = heavy ? [heavy] : ready.filter((step) => step.parallel).slice(0, maxParallel);
        const planned = batch.length > 0 ? batch : [ready[0]];

        const outcomes = await Promise.all(planned.map((stepRow) => executeGraphStep(taskRow, stepRow, controller)));

        if (outcomes.includes("FAILED")) return;
        if (outcomes.includes("CANCELLED")) {
          const [latest] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
          if (latest) await finalizeCancelled(latest, controller);
          return;
        }
        if (outcomes.includes("PAUSED")) {
          await db.update(tasks).set({ status: "PAUSED", controlFlag: null, updatedAt: new Date() }).where(eq(tasks.id, taskId));
          return;
        }
        // An approval gate halts the whole task until the human decides.
        if (outcomes.includes("APPROVAL_WAIT")) return;
      }
    } finally {
      releaseLock();
    }

    // ---- Completion gate: never report success with unmet nodes -------------
    const completedSteps = await db.select().from(planSteps).where(eq(planSteps.taskId, taskId)).orderBy(asc(planSteps.stepIndex));
    const unmet = completedSteps.filter((step) => !["COMPLETED", "SKIPPED"].includes(step.status));
    if (unmet.length > 0) {
      const detail = unmet.map((step) => `${step.title} (${step.status}${step.error ? `: ${step.error.slice(0, 140)}` : ""})`).join(" | ");
      await db
        .update(tasks)
        .set({ status: "FAILED", error: `Task did not complete every planned step: ${detail}`, finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(tasks.id, taskId));
      await emit({
        ts: new Date().toISOString(),
        taskId,
        runId,
        agentId: "master_supervisor",
        type: "SUPERVISOR_MESSAGE",
        message: `I will not report this as complete: ${unmet.length} planned step(s) did not run to completion. ${detail}`,
        severity: "error",
        data: { unmet: unmet.map((step) => ({ step: step.stepIndex + 1, title: step.title, status: step.status, error: step.error })) },
      });
      await writeRunFiles(taskRow, loadFindings(taskRow.workDir));
      return;
    }
    const finalAnswer = composeFinalAnswer(taskRow, completedSteps);
    await db
      .update(tasks)
      .set({ status: "COMPLETED", progress: 100, summary: `Completed ${completedSteps.length} steps`, finalAnswer, finishedAt: new Date(), updatedAt: new Date(), currentStepId: null })
      .where(eq(tasks.id, taskId));
    await setAgentState("master_supervisor", "SPEAKING", { taskId, stationId: stationSlotNode("MASTER_SEAT", 0), message: finalAnswer.slice(0, 400), mood: "REPORTING" });
    await emit({
      ts: new Date().toISOString(),
      taskId,
      runId,
      agentId: "master_supervisor",
      type: "SUPERVISOR_MESSAGE",
      message: finalAnswer,
      severity: "success",
      data: { finalAnswer, artifacts: completedSteps.flatMap((s) => (s.output?.summary ? [String(s.output.summary)] : [])) },
    });
    await emit({ ts: new Date().toISOString(), taskId, runId, agentId: "master_supervisor", type: "TASK_STATUS", message: "Task completed.", severity: "success", data: { status: "COMPLETED" } });
    await writeRunFiles(taskRow, findings);
    await setAgentState("master_supervisor", "IDLE", { taskId: null, stationId: stationSlotNode("MASTER_SEAT", 0), message: "Listening for the next request", mood: "CALM" });
  } catch (error) {
    await logEvent("errors", `Supervisor loop error: ${(error as Error).message}`, { level: "error", taskId, data: { stack: (error as Error).stack?.slice(0, 1500) } });
    await db.update(tasks).set({ status: "FAILED", error: `Supervisor error: ${(error as Error).message}`, finishedAt: new Date(), updatedAt: new Date() }).where(eq(tasks.id, taskId));
    await emit({ ts: new Date().toISOString(), taskId, runId, agentId: "master_supervisor", type: "TOOL_FAILED", message: `Supervisor error: ${(error as Error).message}`, severity: "error" });
  } finally {
    running.delete(taskId);
  }
}

function composeFinalAnswer(taskRow: typeof tasks.$inferSelect, steps: (typeof planSteps.$inferSelect)[]): string {
  const r = roots();
  const completed = steps.filter((s) => s.status === "COMPLETED");
  const failed = steps.filter((s) => s.status === "FAILED");
  const lines: string[] = [];
  lines.push(`Task "${taskRow.title}" finished: ${completed.length}/${steps.length} steps completed${failed.length > 0 ? `, ${failed.length} failed` : ""}.`);
  const summaries = completed.map((s) => `• ${s.title}: ${String(s.output?.summary ?? s.output?.agentMessage ?? "done")}`).join("\n");
  if (summaries) lines.push(summaries);
  const video = steps.flatMap((s) => (s.output?.finalPath ? [String(s.output.finalPath)] : []));
  const reports = steps.flatMap((s) => (s.output?.path && String(s.output.path).endsWith(".md") ? [String(s.output.path)] : []));
  if (reports.length > 0) lines.push(`Files you can open: ${reports.map((p) => relToRoot(p)).join(", ")}`);
  if (video.length > 0) lines.push(`Validated video: ${video.map((p) => relToRoot(p)).join(", ")}`);
  lines.push(`Everything is under the run directory ${relToRoot(taskRow.workDir)} (plan.json, events.json, manifest.json, artifacts).`);
  void r;
  return lines.join("\n\n");
}

async function writeRunFiles(taskRow: typeof tasks.$inferSelect, findings: Findings): Promise<void> {
  try {
    const stepRows = await db.select().from(planSteps).where(eq(planSteps.taskId, taskRow.id)).orderBy(asc(planSteps.stepIndex));
    const eventRows = await db.select().from(eventsTable).where(eq(eventsTable.taskId, taskRow.id)).orderBy(asc(eventsTable.id));
    const approvalRows = await db.select().from(approvals).where(eq(approvals.taskId, taskRow.id)).orderBy(asc(approvals.createdAt));
    const artifactRows = await db.select().from(artifacts).where(eq(artifacts.taskId, taskRow.id)).orderBy(asc(artifacts.createdAt));
    fs.writeFileSync(path.join(taskRow.workDir, "plan.json"), JSON.stringify({ steps: stepRows }, null, 2));
    fs.writeFileSync(path.join(taskRow.workDir, "events.json"), JSON.stringify(eventRows, null, 2));
    fs.writeFileSync(path.join(taskRow.workDir, "approvals.json"), JSON.stringify(approvalRows.map(({ tokenHash, ...rest }) => ({ ...rest, tokenHash: tokenHash ? "[stored]" : null })), null, 2));
    const manifest = {
      taskId: taskRow.id,
      runId: taskRow.runId,
      title: taskRow.title,
      status: taskRow.status,
      createdAt: taskRow.createdAt.toISOString(),
      updatedAt: new Date().toISOString(),
      plannerEngine: taskRow.plannerEngine,
      findings: Object.keys(findings),
      steps: stepRows.map((s) => ({ index: s.stepIndex, title: s.title, agent: s.agentId, tool: s.toolId, status: s.status, risk: s.risk, approvalId: s.approvalId })),
      artifacts: artifactRows.map((a) => ({ id: a.id, kind: a.kind, name: a.name, path: a.relPath, size: a.size, validated: a.validated, sha256: sha256(fs.existsSync(path.join(roots().projectRoot, a.relPath)) ? fs.readFileSync(path.join(roots().projectRoot, a.relPath)) : Buffer.from("missing")) })),
      artifacts_count: artifactRows.length,
    };
    fs.writeFileSync(path.join(taskRow.workDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  } catch (error) {
    await logEvent("errors", `Failed writing run files: ${(error as Error).message}`, { level: "error", taskId: taskRow.id });
  }
}

async function finalizeCancelled(taskRow: typeof tasks.$inferSelect, controller: AbortController): Promise<void> {
  controller.abort();
  const killed = ffmpegJobs.killTask(taskRow.id);
  await db.update(planSteps).set({ status: "CANCELLED" }).where(and(eq(planSteps.taskId, taskRow.id), inArray(planSteps.status, ["PENDING", "WALKING", "RUNNING", "WAITING_APPROVAL"])));
  await db.update(approvals).set({ status: "INVALIDATED", note: "Task cancelled" }).where(and(eq(approvals.taskId, taskRow.id), eq(approvals.status, "PENDING")));
  await db.update(tasks).set({ status: "CANCELLED", controlFlag: null, finishedAt: new Date(), updatedAt: new Date(), error: "Cancelled by the user." }).where(eq(tasks.id, taskRow.id));
  for (const agent of AGENTS) {
    await setAgentState(agent.id, "IDLE", { taskId: null, stationId: stationSlotNode(agent.station, agentSlot(agent.id)), message: "Idle at station", mood: "CALM", emitEvent: agent.id === "master_supervisor" });
  }
  await emit({
    ts: new Date().toISOString(),
    taskId: taskRow.id,
    agentId: "master_supervisor",
    type: "TASK_STATUS",
    message: `Task cancelled. ${killed > 0 ? `${killed} running process(es) were terminated on the host.` : "No host process needed terminating."} Partial artifacts remain in the run directory for inspection.`,
    severity: "warn",
    data: { status: "CANCELLED", killedProcesses: killed },
  });
  await writeRunFiles(taskRow, loadFindings(taskRow.workDir));
}

/* ------------------------------------------------------------------ */
/* Public control surface                                             */
/* ------------------------------------------------------------------ */

export async function resumeTask(taskId: string): Promise<void> {
  await db.update(tasks).set({ controlFlag: null, updatedAt: new Date() }).where(eq(tasks.id, taskId));
  if (running.has(taskId)) return;
  void runTask(taskId);
}

export async function controlTask(taskId: string, action: "pause" | "resume" | "cancel" | "retry"): Promise<{ ok: boolean; message: string }> {
  const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!taskRow) return { ok: false, message: "Task not found." };
  if (action === "pause") {
    if (taskRow.status === "WAITING_APPROVAL") return { ok: false, message: "The task is already waiting for your approval decision." };
    await db.update(tasks).set({ controlFlag: "PAUSE", updatedAt: new Date() }).where(eq(tasks.id, taskId));
    if (!running.has(taskId)) await db.update(tasks).set({ status: "PAUSED", controlFlag: null }).where(eq(tasks.id, taskId));
    return { ok: true, message: running.has(taskId) ? "Pause requested; it takes effect at the next step boundary." : "Task is paused." };
  }
  if (action === "resume") {
    await resumeTask(taskId);
    return { ok: true, message: "Task resumed." };
  }
  if (action === "cancel") {
    await db.update(tasks).set({ controlFlag: "CANCEL", updatedAt: new Date() }).where(eq(tasks.id, taskId));
    if (!running.has(taskId)) {
      const controller = new AbortController();
      await finalizeCancelled(taskRow, controller);
    }
    return { ok: true, message: "Cancel requested. Running host processes are terminated immediately." };
  }
  // retry: reset failed steps and restart
  await db.update(planSteps).set({ status: "PENDING", error: null, finishedAt: null }).where(and(eq(planSteps.taskId, taskId), eq(planSteps.status, "FAILED")));
  await db.update(planSteps).set({ status: "PENDING", approvalId: null }).where(and(eq(planSteps.taskId, taskId), eq(planSteps.status, "WAITING_APPROVAL")));
  await db.update(approvals).set({ status: "INVALIDATED", note: "Task retried" }).where(and(eq(approvals.taskId, taskId), eq(approvals.status, "PENDING")));
  await db.update(tasks).set({ status: "QUEUED", error: null, controlFlag: null, finishedAt: null, updatedAt: new Date() }).where(eq(tasks.id, taskId));
  if (running.has(taskId)) {
    running.get(taskId)?.controller.abort();
    running.delete(taskId);
  }
  void runTask(taskId);
  return { ok: true, message: "Failed steps were reset to pending and the task is running again from the first incomplete step." };
}

export function runningTasks(): { taskId: string; runningForMs: number }[] {
  return Array.from(running.entries()).map(([taskId, entry]) => ({ taskId, runningForMs: Date.now() - entry.startedAt }));
}

export async function killAllProcesses(): Promise<number> {
  let killed = 0;
  for (const taskId of running.keys()) {
    killed += ffmpegJobs.killTask(taskId);
    running.get(taskId)?.controller.abort();
  }
  return killed;
}

export function stageFromPaths(): StationId[] {
  return Object.keys(STATIONS) as StationId[];
}

export function humanFileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export async function purgeExpiredApprovals(): Promise<number> {
  const rows = await db.select().from(approvals).where(eq(approvals.status, "PENDING"));
  let expired = 0;
  for (const row of rows) {
    if (row.expiresAt.getTime() < Date.now()) {
      await db.update(approvals).set({ status: "EXPIRED" }).where(eq(approvals.id, row.id));
      expired += 1;
    }
  }
  return expired;
}

export type { Plan, PlannedStep };
