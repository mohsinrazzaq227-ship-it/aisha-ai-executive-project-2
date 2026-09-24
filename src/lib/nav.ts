/**
 * Deterministic navigation graph for the 3D AI office.
 * Pure data + BFS, shared by the server (walk-time budget in the event stream)
 * and the renderer (actual movement along the same polylines). Agents never
 * teleport: every transit is a real path traversal with arrival detection.
 */

export type Vec2 = [number, number];

export type StationId =
  | "MASTER_SEAT"
  | "RESEARCH_DESK"
  | "COMPUTER_DESK"
  | "DOCUMENT_DESK"
  | "MEDIA_DESK"
  | "SCRIPT_DESK"
  | "EMAIL_DESK"
  | "ASSET_HUB"
  | "MEETING_AREA"
  | "QUALITY_RACK"
  | "HOT_DESK";

export type Station = {
  id: StationId;
  label: string;
  /** Work position (seat / standing spot in front of the console). */
  seat: Vec2;
  /** Navigation node just outside the station. */
  entrance: NodeId;
  facingYaw: number;
  slots: number;
};

export type NodeId = string;

export type NavNode = {
  id: NodeId;
  position: Vec2;
  neighbors: NodeId[];
};

const n = (id: NodeId, position: Vec2, neighbors: NodeId[]): NavNode => ({ id, position, neighbors });

export const NAV_NODES: Record<NodeId, NavNode> = Object.fromEntries(
  [
    n("MASTER_ENT", [0, 1.6], ["C_A"]),
    n("C_A", [0, -0.2], ["MASTER_ENT", "L1", "R1", "C_B"]),
    n("C_B", [0, -2.3], ["C_A", "L2", "R2", "C_C"]),
    n("C_C", [0, -4.8], ["C_B", "C_D", "L2"]),
    n("C_D", [0, -7.0], ["C_C", "SCRIPT_ENT"]),
    n("L1", [-3.8, 0.6], ["C_A", "RESEARCH_ENT", "EMAIL_W"]),
    n("R1", [3.8, 0.6], ["C_A", "COMPUTER_ENT", "RACK_W"]),
    n("L2", [-3.8, -5.6], ["C_B", "C_C", "DOCUMENT_ENT", "MEETING_W"]),
    n("R2", [3.8, -5.6], ["C_B", "MEDIA_ENT"]),
    n("RESEARCH_ENT", [-6.6, 0.6], ["L1", "HOT_W"]),
    n("COMPUTER_ENT", [6.6, 0.6], ["R1"]),
    n("DOCUMENT_ENT", [-6.6, -5.6], ["L2"]),
    n("MEDIA_ENT", [6.6, -5.6], ["R2"]),
    n("SCRIPT_ENT", [0, -8.6], ["C_D"]),
    n("EMAIL_W", [-8.2, 1.6], ["L1", "EMAIL_ENT"]),
    n("EMAIL_ENT", [-11.4, 1.6], ["EMAIL_W"]),
    n("MEETING_W", [-8.2, -5.6], ["L2", "MEETING_ENT"]),
    n("MEETING_ENT", [-11.4, -5.6], ["MEETING_W"]),
    n("RACK_W", [8.4, 4.2], ["R1", "RACK_ENT"]),
    n("RACK_ENT", [11.2, 6.6], ["RACK_W"]),
    n("HOT_W", [-6.6, -1.6], ["RESEARCH_ENT", "HOT_ENT"]),
    n("HOT_ENT", [-6.6, -3.2], ["HOT_W"]),
  ].map((node) => [node.id, node]),
);

export const STATIONS: Record<StationId, Station> = {
  MASTER_SEAT: { id: "MASTER_SEAT", label: "Master Supervisor Office", seat: [0, 3.1], entrance: "MASTER_ENT", facingYaw: Math.PI, slots: 1 },
  RESEARCH_DESK: { id: "RESEARCH_DESK", label: "Research Bay", seat: [-6.6, 0.6], entrance: "RESEARCH_ENT", facingYaw: -Math.PI / 2, slots: 3 },
  COMPUTER_DESK: { id: "COMPUTER_DESK", label: "Computer Control Desk", seat: [6.6, 0.6], entrance: "COMPUTER_ENT", facingYaw: Math.PI / 2, slots: 3 },
  DOCUMENT_DESK: { id: "DOCUMENT_DESK", label: "Document Lab", seat: [-6.6, -5.6], entrance: "DOCUMENT_ENT", facingYaw: -Math.PI / 2, slots: 2 },
  MEDIA_DESK: { id: "MEDIA_DESK", label: "Media Studio", seat: [6.6, -5.6], entrance: "MEDIA_ENT", facingYaw: Math.PI / 2, slots: 4 },
  SCRIPT_DESK: { id: "SCRIPT_DESK", label: "Scriptwriters Room", seat: [0, -8.6], entrance: "SCRIPT_ENT", facingYaw: 0, slots: 2 },
  EMAIL_DESK: { id: "EMAIL_DESK", label: "Communications Desk", seat: [-11.4, 1.6], entrance: "EMAIL_ENT", facingYaw: -Math.PI / 2, slots: 2 },
  ASSET_HUB: { id: "ASSET_HUB", label: "File & Asset Hub", seat: [0, -3.0], entrance: "C_B", facingYaw: Math.PI / 2, slots: 2 },
  MEETING_AREA: { id: "MEETING_AREA", label: "Briefing Table", seat: [-11.4, -5.6], entrance: "MEETING_ENT", facingYaw: Math.PI / 2, slots: 3 },
  QUALITY_RACK: { id: "QUALITY_RACK", label: "Validation Rack", seat: [11.2, 6.6], entrance: "RACK_ENT", facingYaw: Math.PI, slots: 2 },
  HOT_DESK: { id: "HOT_DESK", label: "Flex Desks", seat: [-6.6, -3.2], entrance: "HOT_ENT", facingYaw: -Math.PI / 2, slots: 3 },
};

type RawStation = { id: string; seat: [number, number]; label: string; facingYaw: number; entrance: string; slots: number };

/** Build the walkable node set: station entrances + seat slots + corridors. */
const workingNodes: Record<NodeId, NavNode> = { ...NAV_NODES };
const slotsByStation: Record<string, { slot: number; nodeId: NodeId }[]> = {};

for (const station of Object.values(STATIONS) as Station[]) {
  slotsByStation[station.id] = [];
  for (let slot = 0; slot < station.slots; slot += 1) {
    const offset = slot === 0 ? 0 : slot % 2 === 1 ? Math.ceil(slot / 2) * 1.5 : -Math.ceil(slot / 2) * 1.5;
    const angle = station.facingYaw;
    // Slots spread perpendicular to the facing direction so shared desks don't overlap.
    const px = station.seat[0] + Math.cos(angle + Math.PI / 2) * offset;
    const pz = station.seat[1] + Math.sin(angle + Math.PI / 2) * offset;
    const nodeId = `${station.id}_SEAT_${slot}`;
    workingNodes[nodeId] = n(nodeId, [px, pz], [station.entrance]);
    workingNodes[station.entrance].neighbors = Array.from(new Set([...workingNodes[station.entrance].neighbors, nodeId]));
    slotsByStation[station.id].push({ slot, nodeId });
  }
}

export const WALK_SPEED = 2.35; // world units per second
export const MIN_WALK_MS = 650;
export const MAX_WALK_MS = 9000;

export const NAV = workingNodes;
export const STATION_SLOTS = slotsByStation;

export function stationSlotNode(stationId: StationId, slot: number): NodeId {
  const slots = STATION_SLOTS[stationId] ?? [];
  const found = slots.find((entry) => entry.slot === slot);
  return found ? found.nodeId : (STATIONS[stationId]?.entrance ?? "C_A");
}

export function findNearestNode(position: Vec2): NodeId {
  let best: NodeId = "C_A";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const node of Object.values(workingNodes)) {
    const distance = Math.hypot(node.position[0] - position[0], node.position[1] - position[1]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = node.id;
    }
  }
  return best;
}

/** BFS over the deterministic graph. Stable, obstacle-aware (corridor graph), no teleporting. */
export function findPath(fromNodeId: NodeId, toNodeId: NodeId): NodeId[] {
  if (!workingNodes[fromNodeId] || !workingNodes[toNodeId]) return [];
  if (fromNodeId === toNodeId) return [fromNodeId];
  const queue: NodeId[] = [fromNodeId];
  const cameFrom = new Map<NodeId, NodeId | null>([[fromNodeId, null]]);
  while (queue.length > 0) {
    const current = queue.shift() as NodeId;
    for (const neighbor of workingNodes[current].neighbors) {
      if (cameFrom.has(neighbor)) continue;
      cameFrom.set(neighbor, current);
      if (neighbor === toNodeId) {
        const path: NodeId[] = [neighbor];
        let cursor: NodeId | null = current;
        while (cursor) {
          path.unshift(cursor);
          cursor = cameFrom.get(cursor) ?? null;
        }
        return path;
      }
      queue.push(neighbor);
    }
  }
  return [];
}

export type WalkPlan = {
  from: NodeId;
  to: NodeId;
  path: Vec2[];
  nodes: NodeId[];
  distance: number;
  walkMs: number;
  failed: boolean;
  reason?: string;
};

export function planWalk(fromNodeId: NodeId, toNodeId: NodeId): WalkPlan {
  const nodes = findPath(fromNodeId, toNodeId);
  if (nodes.length === 0) {
    const from = workingNodes[fromNodeId]?.position ?? [0, 0];
    const to = workingNodes[toNodeId]?.position ?? from;
    return { from: fromNodeId, to: toNodeId, path: [from, to], nodes: [fromNodeId, toNodeId], distance: 0, walkMs: MIN_WALK_MS, failed: true, reason: `No route ${fromNodeId} -> ${toNodeId}` };
  }
  let distance = 0;
  const points: Vec2[] = [];
  nodes.forEach((nodeId, index) => {
    const position = workingNodes[nodeId].position;
    points.push(position);
    if (index > 0) {
      const previous = workingNodes[nodes[index - 1]].position;
      distance += Math.hypot(position[0] - previous[0], position[1] - previous[1]);
    }
  });
  const walkMs = Math.round(Math.min(MAX_WALK_MS, Math.max(MIN_WALK_MS, (distance / WALK_SPEED) * 1000)));
  return { from: fromNodeId, to: toNodeId, path: points, nodes, distance, walkMs, failed: false };
}

export function polylineLength(points: Vec2[]): number {
  let distance = 0;
  for (let i = 1; i < points.length; i += 1) {
    distance += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return distance;
}

export function pointAtDistance(points: Vec2[], travelled: number): Vec2 {
  if (points.length === 0) return [0, 0];
  if (points.length === 1) return points[0];
  let remaining = Math.max(0, travelled);
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const segment = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (remaining <= segment) {
      const ratio = segment === 0 ? 0 : remaining / segment;
      return [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio];
    }
    remaining -= segment;
  }
  return points[points.length - 1];
}

export function facingYawBetween(a: Vec2, b: Vec2): number {
  return Math.atan2(b[0] - a[0], b[1] - a[1]);
}
