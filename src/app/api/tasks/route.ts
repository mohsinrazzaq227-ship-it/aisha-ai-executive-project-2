import { z } from "zod";
import { startTask, listTasks, ensureBoot } from "@/lib/supervisor";
import { classifyIncoming } from "@/lib/security";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Body = z.object({ request: z.string().min(3).max(4000) });

export async function GET() {
  await ensureBoot();
  return Response.json({ tasks: await listTasks(40) });
}

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "request must be a string between 3 and 4000 characters" }, { status: 400 });
  }
  const task = await startTask({ request: parsed.data.request });
  return Response.json({ task, incomingRisk: classifyIncoming(parsed.data.request) }, { status: 201 });
}
