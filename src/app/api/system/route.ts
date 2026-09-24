import { agentStates } from "@/db/schema";
import { db } from "@/db";
import { AGENTS, agentSlot, getAgent } from "@/lib/agents";
import { runDoctor } from "@/lib/doctor";
import { tailLog } from "@/lib/logging";
import { providerInventory, providerSummary } from "@/lib/providers";
import { ffmpegJobs } from "@/lib/tools/jobRegistry";
import { missingHandlers } from "@/lib/tools";
import { runningTasks } from "@/lib/supervisor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const wantDoctor = url.searchParams.get("doctor") === "1";
  const logChannel = url.searchParams.get("log");

  const states = await db.select().from(agentStates);
  const providers = await providerInventory();
  const agents = AGENTS.map((agent) => {
    const state = states.find((row) => row.agentId === agent.id);
    return {
      id: agent.id,
      name: agent.name,
      callsign: agent.callsign,
      role: agent.role,
      glyph: agent.glyph,
      color: agent.color,
      accent: agent.accent,
      station: agent.station,
      stationLabel: agent.station,
      slot: agentSlot(agent.id),
      brief: agent.brief,
      capabilities: agent.capabilities,
      tools: agent.tools,
      riskProfile: agent.riskProfile,
      state: state?.state ?? "IDLE",
      mood: state?.mood ?? "CALM",
      taskId: state?.taskId ?? null,
      lastMessage: state?.lastMessage ?? null,
      updatedAt: state?.updatedAt ?? null,
    };
  });

  if (wantDoctor) {
    const report = await runDoctor(true);
    return Response.json({ ok: true, agents, providers, providerSummary: providerSummary(providers), doctor: report, running: runningTasks(), processes: ffmpegJobs.list(), registryGaps: missingHandlers() });
  }

  if (logChannel) {
    return Response.json({ ok: true, channel: logChannel, lines: tailLog(logChannel, 300) });
  }

  return Response.json({
    ok: true,
    agents,
    providers,
    providerSummary: providerSummary(providers),
    running: runningTasks(),
    processes: ffmpegJobs.list(),
    registryGaps: missingHandlers(),
    agentCount: AGENTS.length,
    roles: Array.from(new Set(AGENTS.map((a) => a.role))),
    master: getAgent("master_supervisor"),
  });
}
