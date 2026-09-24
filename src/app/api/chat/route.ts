import { promises as fs } from "node:fs";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { messages, tasks } from "@/db/schema";
import { DIRS, appConfig } from "@/lib/config";
import { startTask, ensureBoot } from "@/lib/supervisor";
import { classifyIncoming } from "@/lib/security";
import { listTools } from "@/lib/tools";
import { newId, slugify } from "@/lib/util";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Body = z.object({ message: z.string().min(1).max(4000), conversationId: z.string().optional() });

/** Quick conversational answers never pretend to have executed work. */
const QUICK = [
  { match: /^(who are you|what are you|introduce yourself)/i, answer: () => "I am AISHA, the master supervisor. I plan work, delegate to 16 specialists, gate risky actions behind your approval, verify every result against real evidence (files, hashes, DOM state, exit codes) and report exactly what happened — including what failed." },
  { match: /^(help|what can you do|commands?|capabilities)/i, answer: () => `I execute real work through ${listTools().length} registered tools: research, browser automation, Windows computer use, file operations, documents (PDF/DOCX/XLSX), data analysis, email, media rendering, voice and shell. Ask for an outcome; I will show the task graph, ask approval when risk is HIGH/CRITICAL, and prove the result.` },
];

export async function GET() {
  await ensureBoot();
  const recent = await db.select().from(messages).orderBy(desc(messages.at)).limit(60);
  const recentTasks = await db.select().from(tasks).orderBy(desc(tasks.createdAt)).limit(10);
  return Response.json({ messages: recent.reverse(), tasks: recentTasks });
}

export async function POST(request: Request) {
  await ensureBoot();
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "message is required" }, { status: 400 });
  const text = parsed.data.message.trim();

  for (const rule of QUICK) {
    if (rule.match.test(text)) {
      const answer = rule.answer();
      await fs.mkdir(DIRS.runs, { recursive: true }).catch(() => undefined);
      await db.insert(messages).values({ id: newId("msg"), role: "assistant", content: answer, engine: "EXPLANATION" });
      return Response.json({ type: "answer", answer, engine: "EXPLANATION", note: "no task was created: this was an explanatory question" });
    }
  }

  const advisory = classifyIncoming(text);
  if (advisory === "CRITICAL") {
    const answer = `This request is classified CRITICAL (${slugify(text).slice(0, 60)}). I will still plan it, but every destructive or security-sensitive step is blocked by the validator unless you widen the policy explicitly. Nothing irreversible will run without a signed approval.`;
    await db.insert(messages).values({ id: newId("msg"), role: "assistant", content: answer, engine: "SECURITY" });
    return Response.json({ type: "warning", answer, engine: "SECURITY" });
  }

  const task = await startTask({ request: text });
  const config = await appConfig();
  return Response.json(
    {
      type: "task",
      task,
      incomingRisk: advisory,
      note: `task created; concurrency ${config.autonomy.maxConcurrentSteps}, heavy limit ${config.autonomy.maxConcurrentHeavy}. Watch /api/events or the task panel for verified results.`,
    },
    { status: 201 },
  );
}

export async function DELETE() {
  await db.delete(messages).where(eq(messages.role, "user"));
  return Response.json({ ok: true, note: "chat transcript cleared (task and audit records are preserved)" });
}
