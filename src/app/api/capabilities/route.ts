import { AGENTS } from "@/lib/agents";
import { capabilityMatrix, probeCapabilities } from "@/lib/capabilities";
import { migrationStatus } from "@/lib/migrations";
import { TOOLS } from "@/lib/tools/registry";
import { missingHandlers } from "@/lib/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Truthful capability registry: every AVAILABLE row passed a functional probe. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const deep = url.searchParams.get("quick") !== "1";
  const capabilities = await probeCapabilities({ deep });
  const migrations = await migrationStatus().catch(() => ({ records: [], pending: ["unknown"], checksumMismatches: [] }));
  return Response.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    matrix: capabilityMatrix(capabilities),
    capabilities,
    migrations,
    registry: {
      tools: Object.values(TOOLS).map((tool) => ({ id: tool.id, risk: tool.risk, requiresApproval: tool.requiresApproval, agent: tool.defaultAgent, hostRequirement: tool.hostRequirement, timeoutMs: tool.timeoutMs, pathScope: tool.pathScope })),
      missingHandlers: missingHandlers(),
    },
    agents: AGENTS.map((agent) => ({ id: agent.id, role: agent.role, callsign: agent.callsign, station: agent.station, riskProfile: agent.riskProfile, tools: agent.tools })),
  });
}
