import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DIRS } from "@/lib/config";
import { voiceStatus } from "@/lib/tools/voice";
import { runTool } from "@/lib/tools";
import { ensureDir, newId, slugify, toRelative, truncate } from "@/lib/util";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Body = z.object({
  action: z.enum(["transcribe", "speak"]),
  text: z.string().max(4000).optional(),
  audioBase64: z.string().max(40_000_000).optional(),
  mimeType: z.string().default("audio/wav"),
});

export async function GET() {
  const status = await voiceStatus();
  return Response.json({
    ...status,
    honesty:
      "LOCAL_ENGINE entries are probed over HTTP; CLIENT_SIDE entries are the browser's own speech APIs used with an explicit label. The server never claims to have transcribed or spoken anything it did not process.",
  });
}

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "action (transcribe|speak) is required" }, { status: 400 });
  const taskId = "voice";
  const ctx = {
    taskId,
    stepId: `voice_${parsed.data.action}_${newId("v")}`,
    agentId: "voice",
    signal: new AbortController().signal,
    approval: null,
  };

  if (parsed.data.action === "transcribe") {
    if (!parsed.data.audioBase64) return Response.json({ error: "audioBase64 is required for transcription" }, { status: 400 });
    const dir = path.join(DIRS.uploads, "voice");
    await ensureDir(dir);
    const ext = parsed.data.mimeType.includes("mp3") ? ".mp3" : parsed.data.mimeType.includes("webm") ? ".webm" : ".wav";
    const file = path.join(dir, `${slugify(`speech-${Date.now()}`)}${ext}`);
    await fs.writeFile(file, Buffer.from(parsed.data.audioBase64, "base64"));
    const result = await runTool({ toolId: "voice.transcribe", params: { path: file }, ctx });
    return Response.json(
      {
        status: result.status,
        summary: result.summary,
        text: (result.data as { text?: string })?.text ?? null,
        engine: (result.data as { engine?: string })?.engine ?? null,
        recordedFile: toRelative(DIRS.root, file),
        detail: truncate(result.summary, 400),
      },
      { status: result.status === "SUCCESS" ? 200 : 501 },
    );
  }

  if (!parsed.data.text) return Response.json({ error: "text is required for speech synthesis" }, { status: 400 });
  const result = await runTool({ toolId: "voice.speak", params: { text: parsed.data.text }, ctx });
  return Response.json(
    {
      status: result.status,
      summary: result.summary,
      audio: (result.data as { artifacts?: unknown[] })?.artifacts ?? null,
      detail: truncate(result.summary, 400),
    },
    { status: result.status === "SUCCESS" ? 200 : 501 },
  );
}
