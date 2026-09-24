import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { events } from "@/db/schema";
import { emit } from "@/lib/events";
import { createTask } from "@/lib/supervisor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Hand a request to the Master Supervisor. Returns immediately; work continues in the backend. */
export async function POST(request: Request) {
  let body: { message?: string; uploadIds?: string[] } = {};
  try {
    body = (await request.json()) as { message?: string; uploadIds?: string[] };
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const message = (body.message ?? "").trim();
  if (message.length === 0) return Response.json({ ok: false, error: "A request is required." }, { status: 400 });
  if (message.length > 4000) return Response.json({ ok: false, error: "Request too long (4000 character limit)." }, { status: 400 });

  await emit({
    ts: new Date().toISOString(),
    agentId: "user",
    type: "USER_MESSAGE",
    message,
    data: { uploadIds: body.uploadIds ?? [], channel: "text" },
  });

  try {
    const result = await createTask(message, body.uploadIds ?? []);
    return Response.json({
      ok: true,
      taskId: result.taskId,
      runId: result.runId,
      title: result.plan.title,
      intent: result.plan.intent,
      planner: { engine: result.plan.engine, detail: result.plan.engineDetail },
      steps: result.plan.steps.map((step, index) => ({ index: index + 1, title: step.title, agent: step.agentId, tool: step.toolId, risk: step.risk, requiresApproval: step.requiresApproval })),
      notes: result.plan.notes,
      workDir: result.workDir,
    });
  } catch (error) {
    return Response.json({ ok: false, error: `Supervisor could not accept the task: ${(error as Error).message}` }, { status: 500 });
  }
}

/** Recent conversation turns taken from the authoritative event stream. */
export async function GET() {
  const rows = await db.select().from(events).where(eq(events.type, "USER_MESSAGE")).orderBy(desc(events.id)).limit(20);
  const supervisorRows = await db.select().from(events).where(eq(events.type, "SUPERVISOR_MESSAGE")).orderBy(desc(events.id)).limit(20);
  return Response.json({
    ok: true,
    userMessages: rows.map((row) => ({ id: row.id, ts: row.ts, message: row.message, taskId: row.taskId })),
    supervisorMessages: supervisorRows.map((row) => ({ id: row.id, ts: row.ts, message: row.message, taskId: row.taskId, severity: row.severity })),
  });
}
