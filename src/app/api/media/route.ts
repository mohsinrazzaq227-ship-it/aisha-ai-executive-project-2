import { z } from "zod";
import { runTool, listTools } from "@/lib/tools";
import { newId } from "@/lib/util";
import { ensureBoot } from "@/lib/supervisor";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cards"), title: z.string().min(1).max(120), scenes: z.array(z.object({ heading: z.string(), body: z.string() })).min(1).max(20), width: z.number().int().min(320).max(1920).default(1280), height: z.number().int().min(240).max(1080).default(720) }),
  z.object({ kind: z.literal("image"), prompt: z.string().min(3).max(1000), width: z.number().int().min(256).max(1920).default(1024), height: z.number().int().min(256).max(1080).default(576) }),
  z.object({ kind: z.literal("video"), title: z.string().min(1).max(120), scenes: z.array(z.object({ heading: z.string(), body: z.string(), seconds: z.number().min(1).max(20).default(3) })).min(1).max(12) }),
  z.object({ kind: z.literal("captions"), title: z.string().min(1).max(120), segments: z.array(z.object({ start: z.number().min(0), end: z.number().min(0.1), text: z.string().min(1) })).min(1).max(200) }),
]);

const TOOL_FOR_KIND = { cards: "media.cards", image: "media.image", video: "media.video", captions: "media.captions" } as const;

export async function GET() {
  return Response.json({
    providers: {
      deterministic: ["media.cards (native PNG composer)", "media.video (ffmpeg + ffprobe validation)", "media.captions"],
      ai: {
        image: process.env.AISHA_IMAGE_API_URL ? "configured" : "not configured (AISHA_IMAGE_API_URL/AISHA_IMAGE_API_KEY)",
        video: process.env.AISHA_VIDEO_API_URL ? "configured" : "not configured (AISHA_VIDEO_API_URL/AISHA_VIDEO_API_KEY)",
      },
    },
    honesty: "Deterministic output is always registered with origin=deterministic. AI generation is only reported when a provider actually returned bytes.",
  });
}

export async function POST(request: Request) {
  await ensureBoot();
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid media request", issues: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  const toolId = TOOL_FOR_KIND[parsed.data.kind];
  const tool = listTools().find((candidate) => candidate.id === toolId);
  const availability = await tool?.availability();
  const params = { ...parsed.data } as Record<string, unknown>;
  delete params.kind;
  const result = await runTool({
    toolId,
    params,
    ctx: { taskId: "media", stepId: `media_${newId("m")}`, agentId: tool?.agents[0] ?? "media_director", signal: new AbortController().signal, approval: null },
  });
  return Response.json(
    { requested: toolId, availability: availability ?? null, status: result.status, summary: result.summary, data: result.data, evidence: result.evidence, verification: result.verification ?? null },
    { status: result.status === "SUCCESS" ? 200 : 501 },
  );
}
