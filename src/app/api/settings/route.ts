import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { db } from "@/db";
import { securityLog } from "@/db/schema";
import { emit } from "@/lib/events";
import { logEvent } from "@/lib/logging";
import { ensureDir, roots } from "@/lib/workspace";
import { pythonSidecar } from "@/lib/pythonSidecar";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Schema = z.object({
  allowedCommands: z.array(z.string().regex(/^[a-z0-9._-]{1,40}$/i)).max(60).optional(),
  autonomy: z
    .object({
      maxConcurrentTasks: z.number().int().min(1).max(8).optional(),
      walkRealism: z.boolean().optional(),
    })
    .optional(),
  media: z
    .object({
      fps: z.number().int().min(12).max(60).optional(),
      crf: z.number().int().min(14).max(34).optional(),
    })
    .optional(),
});

function configPath(): string {
  return path.join(roots().projectRoot, "config", "app.json");
}

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function GET() {
  const r = roots();
  return Response.json({
    ok: true,
    config: readConfig(),
    resolved: {
      projectRoot: r.projectRoot,
      dataRoot: r.dataRoot,
      documentsRoot: r.documentsRoot,
      uploadsRoot: r.uploadsRoot,
      outputRoot: r.outputRoot,
      runsRoot: r.runsRoot,
      logsRoot: r.logsRoot,
      tempRoot: r.tempRoot,
    },
    providers: {
      ollamaUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
      ollamaModel: process.env.OLLAMA_MODEL ?? "llama3.1:8b",
      cloudLlmEnabled: process.env.AI_EXECUTIVE_ENABLE_CLOUD_LLM === "true",
      whisperConfigured: Boolean(process.env.WHISPER_URL),
      ttsConfigured: Boolean(process.env.TTS_URL),
      emailConfigured: Boolean(process.env.IMAP_URL || process.env.SMTP_URL),
    },
    pythonSidecar: pythonSidecar.status(),
    envFile: fs.existsSync(path.join(r.projectRoot, ".env")),
  });
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") }, { status: 400 });
  }
  const current = readConfig();
  const before = { allowedCommands: current.allowedCommands ?? [], autonomy: current.autonomy ?? {}, media: current.media ?? {} };
  const next = {
    ...current,
    ...(parsed.data.allowedCommands ? { allowedCommands: parsed.data.allowedCommands } : {}),
    ...(parsed.data.autonomy ? { autonomy: { ...(current.autonomy as object), ...parsed.data.autonomy } } : {}),
    ...(parsed.data.media ? { media: { ...(current.media as object), ...parsed.data.media } } : {}),
  };
  ensureDir(path.dirname(configPath()));
  const temp = `${configPath()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(temp, configPath());

  // Widening the executable allowlist is a security-relevant change: log it loudly.
  const widened = JSON.stringify(before.allowedCommands) !== JSON.stringify(next.allowedCommands ?? []);
  await db.insert(securityLog).values({
    event: widened ? "settings.allowedCommands.changed" : "settings.updated",
    allowed: true,
    detail: widened ? `Shell allowlist: ${JSON.stringify(before.allowedCommands)} -> ${JSON.stringify(next.allowedCommands)}` : "Autonomy/media settings updated",
    data: { before, after: { allowedCommands: next.allowedCommands, autonomy: next.autonomy, media: next.media } },
  });
  await logEvent("security", `Settings changed by the user (${widened ? "executable allowlist widened/narrowed" : "preferences"})`, { level: "warn", data: { before, after: { allowedCommands: next.allowedCommands, autonomy: next.autonomy } } });
  await emit({
    ts: new Date().toISOString(),
    agentId: "master_supervisor",
    type: "SECURITY",
    message: widened ? "You changed the executable allowlist. This is recorded in the security audit log." : "Settings updated.",
    severity: "warn",
    data: { before, after: { allowedCommands: next.allowedCommands } },
  });
  return Response.json({ ok: true, config: next, changed: { widened } });
}
