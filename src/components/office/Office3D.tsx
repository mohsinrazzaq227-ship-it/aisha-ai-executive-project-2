"use client";

import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { NAV, STATION_SLOTS, STATIONS, type StationId, type Vec2 } from "@/lib/nav";

export type QualityMode = "HIGH" | "BALANCED" | "LOW";

export type AgentRenderState = {
  id: string;
  name: string;
  role: string;
  glyph: string;
  color: string;
  accent: string;
  station: StationId;
  stationLabel: string;
  slot: number;
  state: string;
  mood: string;
  lastMessage: string | null;
  path: Vec2[];
  walkMs: number;
  walkStartedAt: number;
  carrying: { kind: string; name: string } | null;
  taskId: string | null;
};

const QUALITY: Record<QualityMode, { shadows: boolean; segments: number; dpr: [number, number]; particles: number; labels: boolean; softness: number }> = {
  HIGH: { shadows: true, segments: 24, dpr: [1, 2], particles: 90, labels: true, softness: 1 },
  BALANCED: { shadows: true, segments: 16, dpr: [1, 1.5], particles: 40, labels: true, softness: 0.6 },
  LOW: { shadows: false, segments: 10, dpr: [0.75, 1], particles: 0, labels: false, softness: 0.3 },
};

function nodePosition(nodeId: string): Vec2 {
  return (NAV[nodeId]?.position ?? [0, 0]) as Vec2;
}

function seatPosition(station: StationId, slot: number): Vec2 {
  const slots = STATION_SLOTS[station] ?? [];
  const found = slots.find((entry) => entry.slot === slot);
  return found ? nodePosition(found.nodeId) : (STATIONS[station]?.seat ?? [0, 0]);
}

/* ------------------------------- Office shell ------------------------------ */

function OfficeShell({ quality }: { quality: QualityMode }) {
  const config = QUALITY[quality];
  const stations = Object.values(STATIONS);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow={config.shadows}>
        <planeGeometry args={[34, 30]} />
        <meshStandardMaterial color="#0b1220" roughness={0.72} metalness={0.22} />
      </mesh>
      <gridHelper args={[34, 34, "#1d3350", "#132238"]} position={[0, 0.01, -1]} />
      {stations.map((station) => {
        const isMaster = station.id === "MASTER_SEAT";
        const isHub = station.id === "ASSET_HUB";
        const isRack = station.id === "QUALITY_RACK";
        const [x, z] = station.seat;
        return (
          <group key={station.id} position={[x, 0, z]}>
            <mesh position={[0, isMaster ? 0.42 : 0.3, 0]} castShadow={config.shadows} receiveShadow={config.shadows}>
              <boxGeometry args={[isMaster ? 3.4 : isHub ? 2.4 : isRack ? 1.6 : 3, isMaster ? 0.85 : 0.6, isMaster ? 2.2 : isHub ? 2.4 : isRack ? 3.6 : 1.6]} />
              <meshStandardMaterial color={isMaster ? "#3a2d10" : isRack ? "#16202c" : "#16202c"} metalness={0.45} roughness={0.45} />
            </mesh>
            <mesh position={[0, isMaster ? 0.87 : 0.62, 0]}>
              <boxGeometry args={[isMaster ? 2.8 : isHub ? 1.9 : 2.4, 0.08, isMaster ? 1.7 : 1.2]} />
              <meshStandardMaterial
                color={isMaster ? "#f6c045" : "#39d2ff"}
                emissive={isMaster ? "#f6c045" : "#1f7fa8"}
                emissiveIntensity={isMaster ? 0.5 : 0.3}
                metalness={0.6}
                roughness={0.3}
              />
            </mesh>
            {!isMaster && !isHub && (
              <mesh position={[0, 1.25, -0.55]}>
                <boxGeometry args={[1.5, 0.95, 0.08]} />
                <meshStandardMaterial color="#0f2233" emissive="#1b4a68" emissiveIntensity={0.45} />
              </mesh>
            )}
            {isHub && (
              <group>
                {[-0.7, 0, 0.7].map((offset) => (
                  <mesh key={offset} position={[offset, 0.95, 0]}>
                    <boxGeometry args={[0.55, 0.6, 1.1]} />
                    <meshStandardMaterial color="#233246" metalness={0.5} roughness={0.5} />
                  </mesh>
                ))}
              </group>
            )}
            {config.labels && (
              <Html position={[0, isMaster ? 2.1 : 1.9, 0]} center distanceFactor={17} pointerEvents="none">
                <div className={`rounded-md border px-2 py-1 text-[10px] uppercase tracking-[0.16em] backdrop-blur ${isMaster ? "border-amber-300/50 bg-amber-500/10 text-amber-200" : "border-cyan-400/40 bg-slate-950/70 text-cyan-200"}`}>
                  {station.label}
                </div>
              </Html>
            )}
          </group>
        );
      })}

      {/* Master dais + authority ring */}
      <group position={[0, 0, STATIONS.MASTER_SEAT.seat[1] + 1.4]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
          <ringGeometry args={[3.1, 3.35, config.segments * 2]} />
          <meshBasicMaterial color="#f6c045" transparent opacity={0.35} side={THREE.DoubleSide} />
        </mesh>
      </group>

      {/* Walls */}
      {[
        { position: [0, 4, -13] as const, size: [34, 8, 0.4] as const },
        { position: [0, 4, 12] as const, size: [34, 8, 0.4] as const },
        { position: [-16.5, 4, 0] as const, size: [0.4, 8, 26] as const },
        { position: [16.5, 4, 0] as const, size: [0.4, 8, 26] as const },
      ].map((wall, index) => (
        <mesh key={index} position={[wall.position[0], wall.position[1], wall.position[2]]}>
          <boxGeometry args={[wall.size[0], wall.size[1], wall.size[2]]} />
          <meshStandardMaterial color="#070d17" metalness={0.3} roughness={0.9} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

function AmbientDust({ quality }: { quality: QualityMode }) {
  const count = QUALITY[quality].particles;
  const ref = useRef<THREE.Points>(null);
  const positions = useMemo(() => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const array = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      array[i * 3] = (rand() - 0.5) * 32;
      array[i * 3 + 1] = rand() * 7 + 0.4;
      array[i * 3 + 2] = (rand() - 0.5) * 24;
    }
    return array;
  }, [count]);

  useFrame(({ clock }) => {
    if (!ref.current || count === 0) return;
    ref.current.rotation.y = clock.getElapsedTime() * 0.01;
  });

  if (count === 0) return null;
  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.06} color="#7bdff2" transparent opacity={0.4} sizeAttenuation />
    </points>
  );
}

/* -------------------------------- Agent avatar ----------------------------- */

function AgentAvatar({ agent, quality, selected, onSelect }: { agent: AgentRenderState; quality: QualityMode; selected: boolean; onSelect: (id: string) => void }) {
  const group = useRef<THREE.Group>(null);
  const torso = useRef<THREE.Mesh>(null);
  const head = useRef<THREE.Mesh>(null);
  const leftArm = useRef<THREE.Mesh>(null);
  const rightArm = useRef<THREE.Mesh>(null);
  const payload = useRef<THREE.Mesh>(null);
  const config = QUALITY[quality];
  const position = useMemo(() => {
    if (agent.path.length > 0) return agent.path[agent.path.length - 1];
    return seatPosition(agent.station, agent.slot);
  }, [agent.path, agent.station, agent.slot]);

  const phase = agent.walkMs > 0 ? Math.min(1, (Date.now() - agent.walkStartedAt) / agent.walkMs) : 1;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const isWalking = agent.state === "WALKING" || agent.state === "HANDOFF" || agent.state === "RECEIVING";
    if (group.current) {
      if (isWalking && agent.path.length > 1) {
        const elapsed = Date.now() - agent.walkStartedAt;
        const ratio = agent.walkMs > 0 ? Math.min(1, elapsed / agent.walkMs) : 1;
        // Deterministic traversal of the exact backend path, paced by the backend walk duration.
        let travelled = ratio * pathLength(agent.path);
        const target = pointAt(agent.path, travelled);
        group.current.position.x = target[0];
        group.current.position.z = target[1];
        const ahead = pointAt(agent.path, Math.min(pathLength(agent.path), travelled + 0.35));
        group.current.rotation.y = Math.atan2(ahead[0] - target[0], ahead[1] - target[1]);
      } else {
        group.current.position.x += (position[0] - group.current.position.x) * 0.25;
        group.current.position.z += (position[1] - group.current.position.z) * 0.25;
        const station = STATIONS[agent.station];
        group.current.rotation.y = station ? station.facingYaw : 0;
      }
      const bounce = isWalking ? Math.abs(Math.sin(t * 6)) * 0.09 : Math.sin(t * 1.4) * 0.02;
      group.current.position.y = bounce;
    }
    if (torso.current) {
      const working = agent.state === "WORKING";
      torso.current.rotation.x = working ? Math.sin(t * 3.6) * 0.06 : 0;
      const targetScale = agent.state === "ERROR" ? 1 + Math.sin(t * 12) * 0.03 : 1;
      torso.current.scale.setScalar(targetScale);
    }
    if (head.current) {
      const speaking = agent.state === "SPEAKING";
      head.current.rotation.y = speaking ? Math.sin(t * 7) * 0.16 : Math.sin(t * 0.8 + position[0]) * 0.22;
      head.current.rotation.x = agent.state === "ERROR" ? Math.sin(t * 9) * 0.12 : 0;
    }
    const swing = agent.state === "WALKING" ? Math.sin(t * 6.5) * 0.65 : agent.state === "WORKING" ? Math.sin(t * 4) * 0.22 : Math.sin(t * 1.2) * 0.08;
    if (leftArm.current) leftArm.current.rotation.x = swing;
    if (rightArm.current) rightArm.current.rotation.x = -swing;
    if (payload.current) {
      payload.current.rotation.y = t * 0.9;
      payload.current.position.y = 1.6 + Math.sin(t * 2.4) * 0.06;
    }
  });

  const isError = agent.state === "ERROR";
  const bodyColor = isError ? "#7f1d1d" : agent.color;
  const emissive = agent.state === "WORKING" ? 0.45 : agent.state === "SPEAKING" ? 0.7 : agent.state === "WAITING_APPROVAL" ? 0.3 : 0.12;
  const bubbleState = ["SPEAKING", "HANDOFF", "RECEIVING", "COMPLETED", "ERROR", "WAITING_APPROVAL"].includes(agent.state);

  return (
    <group position={[position[0], 0, position[1]]}>
      <group ref={group} onClick={(event) => { event.stopPropagation(); onSelect(agent.id); }}>
        {/* Legs */}
        <mesh position={[-0.16, 0.42, 0]} castShadow={config.shadows}>
          <capsuleGeometry args={[0.09, 0.5, 4, config.segments]} />
          <meshStandardMaterial color="#1f2937" roughness={0.7} />
        </mesh>
        <mesh position={[0.16, 0.42, 0]} castShadow={config.shadows}>
          <capsuleGeometry args={[0.09, 0.5, 4, config.segments]} />
          <meshStandardMaterial color="#1f2937" roughness={0.7} />
        </mesh>
        {/* Torso */}
        <mesh ref={torso} position={[0, 1.06, 0]} castShadow={config.shadows}>
          <capsuleGeometry args={[0.26, 0.52, 6, config.segments]} />
          <meshStandardMaterial color={bodyColor} emissive={bodyColor} emissiveIntensity={emissive} metalness={0.35} roughness={0.42} />
        </mesh>
        {/* Arms */}
        <mesh ref={leftArm} position={[-0.38, 1.16, 0]} castShadow={config.shadows}>
          <capsuleGeometry args={[0.07, 0.46, 4, config.segments]} />
          <meshStandardMaterial color={agent.accent} metalness={0.2} roughness={0.6} />
        </mesh>
        <mesh ref={rightArm} position={[0.38, 1.16, 0]} castShadow={config.shadows}>
          <capsuleGeometry args={[0.07, 0.46, 4, config.segments]} />
          <meshStandardMaterial color={agent.accent} metalness={0.2} roughness={0.6} />
        </mesh>
        {/* Head + visor */}
        <mesh ref={head} position={[0, 1.62, 0]} castShadow={config.shadows}>
          <sphereGeometry args={[0.24, config.segments, config.segments]} />
          <meshStandardMaterial color="#0f172a" emissive={agent.color} emissiveIntensity={0.25} metalness={0.5} roughness={0.35} />
        </mesh>
        <mesh position={[0, 1.62, 0.19]}>
          <boxGeometry args={[0.28, 0.09, 0.06]} />
          <meshStandardMaterial color={agent.accent} emissive={agent.accent} emissiveIntensity={agent.state === "SPEAKING" ? 0.9 : 0.4} />
        </mesh>
        {/* Status ring */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
          <ringGeometry args={[selected ? 0.52 : 0.44, selected ? 0.62 : 0.5, 28]} />
          <meshBasicMaterial color={selected ? "#ffffff" : stateColor(agent.state)} transparent opacity={selected ? 0.85 : 0.55} side={THREE.DoubleSide} />
        </mesh>
        {/* Authority halo for the Master */}
        {agent.id === "master_supervisor" && (
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]}>
            <ringGeometry args={[0.72, 0.86, 36]} />
            <meshBasicMaterial color="#f6c045" transparent opacity={0.5} side={THREE.DoubleSide} />
          </mesh>
        )}
      </group>

      {/* Real payload object, only present when a real artifact is being handed over */}
      {agent.carrying && (
        <mesh ref={payload} position={[0, 1.6, 0.42]}>
          <boxGeometry args={[0.34, 0.42, 0.1]} />
          <meshStandardMaterial color="#8ff0ff" emissive="#4cc9f0" emissiveIntensity={1.2} transparent opacity={0.9} />
        </mesh>
      )}

      {config.labels && (
        <Html position={[0, agent.carrying ? 2.55 : 2.2, 0]} center distanceFactor={16} pointerEvents="none">
          <div className="flex flex-col items-center gap-1">
            <div className="rounded-md border border-white/15 bg-slate-950/80 px-2 py-0.5 text-[10px] font-medium text-white/90 backdrop-blur">
              <span className="mr-1">{agent.glyph}</span>
              {agent.name}
              <span className="ml-1 text-white/40">{agent.role.replace(" Agent", "")}</span>
            </div>
            <div className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-[0.14em] ${stateClass(agent.state)}`}>{agent.state.replace("_", " ")}</div>
            {bubbleState && agent.lastMessage && (
              <div className="max-w-[220px] rounded-lg border border-cyan-300/30 bg-slate-950/90 px-2 py-1 text-[10px] leading-snug text-cyan-100 shadow-lg shadow-cyan-500/10">
                {agent.lastMessage.slice(0, 150)}
              </div>
            )}
          </div>
        </Html>
      )}
    </group>
  );
}

function stateColor(state: string): string {
  switch (state) {
    case "WORKING":
      return "#4cc9f0";
    case "WALKING":
      return "#ffd166";
    case "SPEAKING":
      return "#a0e7e5";
    case "WAITING_APPROVAL":
      return "#ff9f68";
    case "COMPLETED":
      return "#70e000";
    case "ERROR":
      return "#ff5a5f";
    case "HANDOFF":
    case "RECEIVING":
      return "#c084fc";
    default:
      return "#64748b";
  }
}

function stateClass(state: string): string {
  switch (state) {
    case "WORKING":
      return "bg-cyan-500/20 text-cyan-200";
    case "WALKING":
      return "bg-amber-500/20 text-amber-200";
    case "SPEAKING":
      return "bg-teal-500/20 text-teal-100";
    case "WAITING_APPROVAL":
      return "bg-orange-500/20 text-orange-200";
    case "COMPLETED":
      return "bg-lime-500/20 text-lime-200";
    case "ERROR":
      return "bg-red-600/30 text-red-200";
    case "HANDOFF":
    case "RECEIVING":
      return "bg-fuchsia-500/20 text-fuchsia-200";
    default:
      return "bg-slate-600/25 text-slate-300";
  }
}

function pathLength(points: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return total;
}

function pointAt(points: Vec2[], travelled: number): Vec2 {
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

/* --------------------------------- Scene ---------------------------------- */

export function Office3D({
  agents,
  quality,
  selectedAgentId,
  onSelectAgent,
}: {
  agents: AgentRenderState[];
  quality: QualityMode;
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
}) {
  const config = QUALITY[quality];
  return (
    <Canvas
      shadows={config.shadows}
      dpr={config.dpr}
      camera={{ position: [0, 15, 19], fov: 46 }}
      gl={{ antialias: quality !== "LOW", powerPreference: quality === "LOW" ? "low-power" : "high-performance" }}
      onCreated={({ scene }) => {
        scene.fog = new THREE.Fog("#05080f", 26, 52);
      }}
    >
      <color attach="background" args={["#05080f"]} />
      <hemisphereLight intensity={0.5 * config.softness + 0.25} groundColor="#0b1220" color="#a5d8ff" />
      <directionalLight
        position={[10, 16, 8]}
        intensity={0.9 * config.softness + 0.35}
        castShadow={config.shadows}
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-20}
        shadow-camera-right={20}
        shadow-camera-top={20}
        shadow-camera-bottom={-20}
      />
      <pointLight position={[0, 6, STATIONS.MASTER_SEAT.seat[1]]} intensity={1.2} color="#f6c045" distance={14} />
      <pointLight position={[-6.6, 4, 0.6]} intensity={0.9} color="#4cc9f0" distance={12} />
      <pointLight position={[6.6, 4, -5.6]} intensity={0.9} color="#ff5da2" distance={12} />
      <OfficeShell quality={quality} />
      <AmbientDust quality={quality} />
      {agents.map((agent) => (
        <AgentAvatar key={agent.id} agent={agent} quality={quality} selected={selectedAgentId === agent.id} onSelect={onSelectAgent} />
      ))}
      <OrbitControls
        target={[0, 1, -1.5]}
        enablePan
        enableDamping
        dampingFactor={0.08}
        minDistance={6}
        maxDistance={40}
        maxPolarAngle={Math.PI / 2.15}
      />
    </Canvas>
  );
}

export default Office3D;
