import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { approvals } from "@/db/schema";
import { getAgent } from "@/lib/agents";
import { getTool } from "@/lib/tools/registry";
import { decideApproval, purgeExpiredApprovals } from "@/lib/supervisor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  await purgeExpiredApprovals();
  const rows = await db.select().from(approvals).orderBy(desc(approvals.createdAt)).limit(40);
  return Response.json({
    ok: true,
    approvals: rows.map((row) => {
      let toolLabel = row.toolId;
      let approvalLabel = row.toolId;
      let risk = row.risk;
      let params: { name: string; type: string; required: boolean; description: string }[] = [];
      try {
        const tool = getTool(row.toolId);
        toolLabel = tool.description;
        approvalLabel = tool.approvalLabel;
        risk = tool.risk;
        params = tool.params;
      } catch {
        /* tool removed from the registry: still show the record honestly */
      }
      const agent = getAgent(row.agentId);
      return {
        id: row.id,
        taskId: row.taskId,
        stepId: row.stepId,
        agentId: row.agentId,
        agent: { name: agent.name, role: agent.role, glyph: agent.glyph, color: agent.color, callsign: agent.callsign },
        toolId: row.toolId,
        toolLabel,
        approvalLabel,
        risk,
        action: row.action,
        parameters: params,
        parametersHash: row.parametersHash,
        reason: row.reason,
        target: row.target,
        status: row.status,
        decision: row.decision,
        scope: row.scope,
        note: row.note,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        decidedAt: row.decidedAt,
        expired: row.status === "PENDING" && row.expiresAt.getTime() < Date.now(),
      };
    }),
  });
}

export async function POST(request: Request) {
  let body: { approvalId?: string; decision?: string; note?: string; parameters?: Record<string, unknown> } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const allowed = ["APPROVE_ONCE", "APPROVE_SESSION", "DENY", "MODIFY"] as const;
  type Decision = (typeof allowed)[number];
  if (!body.approvalId || !body.decision || !allowed.includes(body.decision as Decision)) {
    return Response.json({ ok: false, error: `approvalId and decision (${allowed.join("|")}) are required.` }, { status: 400 });
  }
  const result = await decideApproval(body.approvalId, body.decision as Decision, { note: body.note, parameters: body.parameters });
  const [row] = await db.select().from(approvals).where(eq(approvals.id, body.approvalId)).limit(1);
  return Response.json({ ok: result.ok, message: result.message, status: row?.status ?? null, invalidated: result.invalidated ?? false }, { status: result.ok ? 200 : 400 });
}
