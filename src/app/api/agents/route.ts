import { AGENTS } from "@/lib/agents";
import { agentsForOffice, officeLayout } from "@/lib/office";
import { listTools } from "@/lib/tools";
import { ensureBoot } from "@/lib/supervisor";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureBoot();
  const live = await agentsForOffice();
  return Response.json({
    agents: live,
    definitions: AGENTS.map((agent) => ({
      id: agent.id,
      name: agent.name,
      callsign: agent.callsign,
      role: agent.role,
      tier: agent.tier,
      station: agent.station,
      personality: agent.personality,
      capabilities: agent.capabilities,
      riskProfile: agent.riskProfile,
      brief: agent.brief,
      tools: listTools().filter((tool) => tool.agents.includes(agent.id)).map((tool) => ({ id: tool.id, risk: tool.risk, group: tool.group })),
    })),
    layout: officeLayout(),
  });
}
