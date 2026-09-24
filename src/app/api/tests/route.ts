import { z } from "zod";
import { lastTestRuns, runAcceptanceSuite } from "@/lib/tests/suite";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function GET() {
  const runs = await lastTestRuns(5);
  return Response.json({
    runs,
    latest: runs[0]
      ? {
          id: runs[0].id,
          passed: runs[0].passed,
          failed: runs[0].failed,
          total: runs[0].total,
          ms: runs[0].ms,
          at: runs[0].at,
          results: runs[0].results,
        }
      : null,
  });
}

const Body = z.object({ confirm: z.literal("run-acceptance-suite") });

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "POST with {\"confirm\":\"run-acceptance-suite\"} to execute the real runtime suite" }, { status: 400 });
  }
  const run = await runAcceptanceSuite();
  return Response.json(run, { status: 200 });
}
