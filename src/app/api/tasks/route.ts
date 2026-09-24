import { asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { approvals, artifacts, planSteps, tasks } from "@/db/schema";
import { getAgent } from "@/lib/agents";
import { controlTask, runningTasks } from "@/lib/supervisor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const taskRows = await db.select().from(tasks).orderBy(desc(tasks.createdAt)).limit(40);
  const ids = taskRows.map((row) => row.id);
  const stepRows = ids.length > 0 ? await db.select().from(planSteps).where(inArray(planSteps.taskId, ids)).orderBy(asc(planSteps.stepIndex)) : [];
  const artifactRows = ids.length > 0 ? await db.select().from(artifacts).where(inArray(artifacts.taskId, ids)).orderBy(desc(artifacts.createdAt)) : [];
  const approvalRows = ids.length > 0 ? await db.select().from(approvals).where(inArray(approvals.taskId, ids)).orderBy(desc(approvals.createdAt)) : [];
  const running = runningTasks();

  return Response.json({
    ok: true,
    tasks: taskRows.map((task) => ({
      id: task.id,
      runId: task.runId,
      title: task.title,
      intent: task.intent,
      status: task.status,
      progress: task.progress,
      plannerEngine: task.plannerEngine,
      currentAgentId: task.currentAgentId,
      currentAgent: task.currentAgentId ? { name: getAgent(task.currentAgentId).name, role: getAgent(task.currentAgentId).role, glyph: getAgent(task.currentAgentId).glyph } : null,
      summary: task.summary,
      finalAnswer: task.finalAnswer,
      error: task.error,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      finishedAt: task.finishedAt,
      workDir: task.workDir,
      request: task.request,
      running: running.some((r) => r.taskId === task.id),
      steps: stepRows
        .filter((step) => step.taskId === task.id)
        .map((step) => ({
          id: step.id,
          index: step.stepIndex,
          title: step.title,
          detail: step.detail,
          agentId: step.agentId,
          agentName: getAgent(step.agentId).name,
          toolId: step.toolId,
          risk: step.risk,
          requiresApproval: step.requiresApproval,
          status: step.status,
          approvalId: step.approvalId,
          summary: (step.output as { summary?: string } | null)?.summary ?? null,
          error: step.error,
          startedAt: step.startedAt,
          finishedAt: step.finishedAt,
        })),
      artifacts: artifactRows
        .filter((artifact) => artifact.taskId === task.id)
        .map((artifact) => ({ id: artifact.id, kind: artifact.kind, name: artifact.name, relPath: artifact.relPath, mime: artifact.mime, size: artifact.size, validated: artifact.validated, meta: artifact.meta, createdAt: artifact.createdAt })),
      approvals: approvalRows
        .filter((approval) => approval.taskId === task.id)
        .map((approval) => ({ id: approval.id, stepId: approval.stepId, toolId: approval.toolId, toolLabel: approval.toolId, risk: approval.risk, status: approval.status, decision: approval.decision, target: approval.target, reason: approval.reason, parametersHash: approval.parametersHash, expiresAt: approval.expiresAt, createdAt: approval.createdAt, action: approval.action, agentId: approval.agentId })),
    })),
  });
}

export async function PATCH(request: Request) {
  let body: { taskId?: string; action?: string } = {};
  try {
    body = (await request.json()) as { taskId?: string; action?: string };
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const action = body.action as "pause" | "resume" | "cancel" | "retry" | undefined;
  if (!body.taskId || !action || !["pause", "resume", "cancel", "retry"].includes(action)) {
    return Response.json({ ok: false, error: "taskId and a valid action (pause|resume|cancel|retry) are required." }, { status: 400 });
  }
  const result = await controlTask(body.taskId, action);
  const [row] = await db.select().from(tasks).where(eq(tasks.id, body.taskId)).limit(1);
  return Response.json({ ok: result.ok, message: result.message, status: row?.status ?? null }, { status: result.ok ? 200 : 400 });
}
