import { z } from "zod";
import { listApprovals, decideApproval, ensureBoot } from "@/lib/supervisor";

export const dynamic = "force-dynamic";

const Body = z.object({
  id: z.string().min(3),
  decision: z.enum(["GRANTED", "DENIED"]),
  actor: z.string().min(1).max(80).default("operator"),
  note: z.string().max(500).optional(),
  token: z.string().optional(),
});

export async function GET() {
  await ensureBoot();
  const rows = await listApprovals(100);
  return Response.json({
    approvals: rows,
    pending: rows.filter((row) => row.status === "PENDING").length,
  });
}

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "id and decision (GRANTED|DENIED) are required" }, { status: 400 });
  const result = await decideApproval(parsed.data);
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
