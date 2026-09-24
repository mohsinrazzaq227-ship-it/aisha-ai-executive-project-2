"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { Grid, Html, OrbitControls } from "@react-three/drei";
import { useMemo, useRef } from "react";
import type { Group } from "three";
import { Pill } from "@/components/ui";

export type OfficeStation = { id: string; label: string; x: number; z: number; kind: string };
export type OfficeAgent = {
  id: string;
  name: string;
  role: string;
  tier: string;
  color: string;
  glyph: string;
  station: string;
  state: string;
  message: string | null;
  mood: string;
  taskId: string | null;
  position: { x: number; z: number };
  walk: { from: { x: number; z: number }; to: { x: number; z: number }; startedAt: number; durationMs: number; mode: string } | null;
  payload: Record<string, unknown> | null;
};

const STATE_COLORS: Record<string, string> = {
  IDLE: "#64748b",
  THINKING: "#a78bfa",
  PLANNING: "#818cf8",
  WORKING: "#38bdf8",
  RESEARCHING: "#22d3ee",
  WAITING: "#facc15",
  REQUESTING_APPROVAL: "#fb923c",
  HANDING_OFF: "#f472b6",
  RECEIVING: "#34d399",
  VERIFYING: "#a3e635",
  SUCCESS: "#4ade80",
  FAILED: "#f87171",
};

/** Real position from persisted walk window (startedAt + durationMs), not a local animation. */
function useWalkPosition(agent: OfficeAgent) {
  const walk = agent.walk;
  const group = useRef<Group>(null);
  const walking = useRef(false);
  useFrame(() => {
    if (!group.current) return;
    if (!walk) {
      walking.current = false;
      group.current.position.set(agent.position.x, 0, agent.position.z);
      return;
    }
    walking.current = Date.now() < walk.startedAt + walk.durationMs;
    const progress = Math.min(1, Math.max(0, (Date.now() - walk.startedAt) / Math.max(1, walk.durationMs)));
    const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    const x = walk.from.x + (walk.to.x - walk.from.x) * eased;
    const z = walk.from.z + (walk.to.z - walk.from.z) * eased;
    group.current.position.set(x, 0, z);
  });
  return { group, walking };
}

function AgentFigure({ agent, selected, onSelect }: { agent: OfficeAgent; selected: boolean; onSelect: (id: string) => void }) {
  const { group, walking } = useWalkPosition(agent);
  const color = STATE_COLORS[agent.state] ?? "#94a3b8";
  const bob = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (!bob.current) return;
    const active = agent.state !== "IDLE";
    bob.current.position.y = active ? Math.sin(clock.elapsedTime * (walking.current ? 8 : 3)) * 0.08 + 0.06 : 0;
  });
  return (
    <group ref={group} position={[agent.position.x, 0, agent.position.z]}>
      <group ref={bob} onClick={(event) => { event.stopPropagation(); onSelect(agent.id); }}>
        <mesh position={[0, 0.95, 0]} castShadow>
          <capsuleGeometry args={[0.26, 0.9, 6, 12]} />
          <meshStandardMaterial color={agent.color} emissive={selected ? agent.color : color} emissiveIntensity={selected ? 0.65 : 0.25} metalness={0.2} roughness={0.5} />
        </mesh>
        <mesh position={[0, 1.72, 0]} castShadow>
          <sphereGeometry args={[0.26, 16, 16]} />
          <meshStandardMaterial color={agent.color} emissive={color} emissiveIntensity={0.3} />
        </mesh>
        <mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.4, 0.52, 24]} />
          <meshBasicMaterial color={color} transparent opacity={agent.state === "IDLE" ? 0.25 : 0.85} />
        </mesh>
        {(agent.state === "HANDING_OFF" || agent.state === "RECEIVING" || agent.payload) && (
          <mesh position={[0.42, 1.35, 0]}>
            <boxGeometry args={[0.24, 0.18, 0.24]} />
            <meshStandardMaterial color="#f6c045" emissive="#f6c045" emissiveIntensity={0.6} />
          </mesh>
        )}
      </group>
      <Html position={[0, 2.25, 0]} center distanceFactor={14} occlude={false}>
        <div
          onClick={() => onSelect(agent.id)}
          className={`cursor-pointer whitespace-nowrap rounded-lg border px-2 py-1 text-[10px] leading-tight backdrop-blur ${
            selected ? "border-amber-400/70 bg-amber-400/20 text-amber-100" : "border-white/15 bg-black/60 text-slate-200"
          }`}
        >
          <div className="font-semibold">
            {agent.glyph} {agent.name}
          </div>
          <div className="text-[9px]" style={{ color }}>
            {agent.state}
          </div>
        </div>
      </Html>
    </group>
  );
}

function StationBox({ station, occupied }: { station: OfficeStation; occupied: boolean }) {
  const color = station.kind === "desk" ? "#1e293b" : station.kind === "gate" ? "#3f1d1d" : station.kind === "stage" ? "#2a2350" : "#172554";
  return (
    <group position={[station.x, 0, station.z]}>
      <mesh position={[0, 0.35, 0]} castShadow receiveShadow>
        <boxGeometry args={[2.4, 0.7, 1.8]} />
        <meshStandardMaterial color={color} emissive={occupied ? "#f6c045" : "#000000"} emissiveIntensity={occupied ? 0.18 : 0} metalness={0.3} roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.78, 0]}>
        <boxGeometry args={[1.6, 0.08, 1.1]} />
        <meshStandardMaterial color="#0f172a" emissive="#38bdf8" emissiveIntensity={occupied ? 0.5 : 0.12} />
      </mesh>
      <Html position={[0, 1.15, 0]} center distanceFactor={16}>
        <span className="rounded bg-black/60 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-slate-400">{station.label}</span>
      </Html>
    </group>
  );
}

export function Office3D({
  stations,
  agents,
  selected,
  onSelect,
}: {
  stations: OfficeStation[];
  agents: OfficeAgent[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const occupied = useMemo(() => new Set(agents.filter((agent) => agent.state !== "IDLE").map((agent) => agent.station)), [agents]);
  return (
    <Canvas shadows camera={{ position: [0, 18, 24], fov: 42 }} dpr={[1, 2]}>
      <color attach="background" args={["#05070f"]} />
      <ambientLight intensity={0.45} />
      <directionalLight position={[12, 20, 8]} intensity={1.1} castShadow />
      <pointLight position={[-10, 8, -6]} intensity={0.5} color="#4cc9f0" />
      <Grid position={[0, 0, 0]} cellSize={2} cellColor="#111827" sectionColor="#1f2937" fadeDistance={60} infiniteGrid />
      {stations.map((station) => (
        <StationBox key={station.id} station={station} occupied={occupied.has(station.id)} />
      ))}
      {agents.map((agent) => (
        <AgentFigure key={agent.id} agent={agent} selected={selected === agent.id} onSelect={onSelect} />
      ))}
      <OrbitControls enablePan target={[0, 0, -1]} minDistance={8} maxDistance={48} maxPolarAngle={Math.PI / 2.4} />
    </Canvas>
  );
}

export function AgentInspector({ agent }: { agent: OfficeAgent | null }) {
  if (!agent) {
    return <p className="text-xs text-slate-400">Click an agent in the office to inspect its real state, task binding and payload.</p>;
  }
  return (
    <div className="space-y-2 text-xs text-slate-300">
      <div className="flex items-center gap-2">
        <span className="text-lg">{agent.glyph}</span>
        <div>
          <p className="font-semibold text-slate-100">{agent.name}</p>
          <p className="text-[11px] text-slate-400">{agent.role}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Pill value={agent.state} />
        <Pill value={agent.tier} />
        <Pill value={agent.mood} />
      </div>
      <p className="text-[11px] text-slate-400">
        station <span className="text-slate-200">{agent.station}</span> · position ({agent.position.x}, {agent.position.z})
      </p>
      <p className="text-[11px] text-slate-400">
        task {agent.taskId ?? "none"} · {agent.message ?? "no message"}
      </p>
      {agent.walk && (
        <p className="text-[11px] text-amber-300">
          walking {agent.walk.mode}: ({agent.walk.from.x},{agent.walk.from.z}) → ({agent.walk.to.x},{agent.walk.to.z}) in {agent.walk.durationMs}ms
        </p>
      )}
      {agent.payload && (
        <pre className="max-h-32 overflow-auto rounded-lg border border-white/10 bg-black/40 p-2 text-[10px] text-slate-400">{JSON.stringify(agent.payload, null, 2)}</pre>
      )}
      <p className="text-[10px] text-slate-500">state, position and walk windows are read from the server, never simulated locally.</p>
    </div>
  );
}
