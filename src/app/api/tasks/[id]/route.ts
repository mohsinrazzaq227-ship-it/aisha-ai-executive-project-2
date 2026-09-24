import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { approvals, artifacts, events, messages, steps as stepsTable, tasks, toolRuns } from "@/db/schema";
import { cancelTask, startTask } from "@/lib/supervisor";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!task) return Response.json({ error: `task ${id} not found` }, { status: 404 });
  const [stepRows, approvalRows, artifactRows, eventRows, runRows, messageRows] = await Promise.all([
    db.select().from(stepsTable).where(eq(stepsTable.taskId, id)).orderBy(asc(stepsTable.stepIndex)),
    db.select().from(approvals).where(eq(approvals.taskId, id)).orderBy(desc(approvals.requestedAt)),
    db.select().from(artifacts).where(eq(artifacts.taskId, id)).orderBy(desc(artifacts.createdAt)),
    db.select().from(events).where(eq(events.taskId, id)).orderBy(asc(events.id)).limit(500),
    db.select().from(toolRuns).where(eq(toolRuns.taskId, id)).orderBy(desc(toolRuns.at)).limit(200),
    db.select().from(messages).where(eq(messages.taskId, id)).orderBy(asc(messages.at)),
  ]);
  return Response.json({ task, steps: stepRows, approvals: approvalRows, artifacts: artifactRows, events: eventRows, toolRuns: runRows, messages: messageRows });
}

const Action = z.object({ action: z.enum(["cancel", "retry"]) });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const parsed = Action.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "action must be 'cancel' or 'retry'" }, { status: 400 });

  const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!task) return Response.json({ error: `task ${id} not found` }, { status: 404 });

  if (parsed.data.action === "cancel") {
    const result = await cancelTask(id, "operator");
    return Response.json(result, { status: result.ok ? 200 : 404 });
  }

  const steps = await db.select().from(stepsTable).where(eq(stepsTable.taskId, id));
  const failed = steps.filter((step) => step.status !== "SUCCESS");
  const retried = await startTask({ request: task.request });
  return Response.json(
    {
      retriedFrom: task.id,
      newTask: retried,
      note: `retry created a fresh task graph for the same request (${failed.length} non-successful step(s) in the original)`,
    },
    { status: 201 },
  );
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const pending = await db.select().from(approvals).where(and(eq(approvals.taskId, id), eq(approvals.status, "PENDING")));
  return Response.json({ taskId: id, pendingApprovals: pending.length, note: "task rows are preserved as audit evidence; no destructive delete is offered" });
}
