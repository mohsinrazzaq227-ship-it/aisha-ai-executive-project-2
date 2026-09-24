/**
 * Office projection: server-side truth for the 3D office.
 *
 * The client performs no path-finding and invents no state. It receives the
 * layout, each agent's real state/task and the persisted walk window
 * (startedAt + durationMs), so an agent appears where the backend says it is.
 */
import { loadAgentStateRows } from "@/lib/agents";
import { STATIONS, AGENTS } from "@/lib/agents";

export type OfficeAgent = {
  id: string;
  name: string;
  callsign: string;
  role: string;
  tier: string;
  color: string;
  accent: string;
  glyph: string;
  station: string;
  state: string;
  taskId: string | null;
  stepId: string | null;
  message: string | null;
  mood: string;
  position: { x: number; z: number };
  walk: { from: { x: number; z: number }; to: { x: number; z: number }; startedAt: number; durationMs: number; mode: string } | null;
  payload: Record<string, unknown> | null;
  updatedAt: string;
};

export function officeLayout() {
  return {
    stations: Object.values(STATIONS),
    bounds: { minX: -18, maxX: 18, minZ: -12, maxZ: 10 },
    floors: [
      { id: "main", label: "Operations Floor", x: 0, z: -1, width: 40, depth: 22 },
    ],
  };
}

export async function agentsForOffice(): Promise<OfficeAgent[]> {
  const rows = await loadAgentStateRows();
  return AGENTS.map((agent) => {
    const row = rows.find((state) => state.agentId === agent.id);
    const station = STATIONS[agent.station];
    const walk = row?.walk ?? null;
    return {
      id: agent.id,
      name: agent.name,
      callsign: agent.callsign,
      role: agent.role,
      tier: agent.tier,
      color: agent.color,
      accent: agent.accent,
      glyph: agent.glyph,
      station: row?.stationId ?? station.id,
      state: row?.state ?? "IDLE",
      taskId: row?.taskId ?? null,
      stepId: row?.stepId ?? null,
      message: row?.lastMessage ?? null,
      mood: row?.mood ?? "CALM",
      position: row?.position ?? { x: station.x, z: station.z },
      walk: walk
        ? { from: { x: walk.from.x, z: walk.from.z }, to: { x: walk.to.x, z: walk.to.z }, startedAt: walk.startedAt, durationMs: walk.durationMs, mode: walk.mode }
        : null,
      payload: row?.payload ?? null,
      updatedAt: (row?.updatedAt ?? new Date()).toISOString(),
    };
  });
}
