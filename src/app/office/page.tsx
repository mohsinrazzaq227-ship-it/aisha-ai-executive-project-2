"use client";

import dynamicImport from "next/dynamic";
import { useState } from "react";
import { AgentInspector, type OfficeAgent } from "@/components/Office3D";
import { Card, useEventStream, usePolling } from "@/components/ui";

const Office3D = dynamicImport(() => import("@/components/Office3D").then((module) => module.Office3D), { ssr: false });

type AgentsPayload = { agents: OfficeAgent[]; layout: { stations: Array<{ id: string; label: string; x: number; z: number; kind: string }> } };

export default function OfficePage() {
  const [selected, setSelected] = useState<string | null>(null);
  const agents = usePolling<AgentsPayload>("/api/agents", 2000);
  const events = useEventStream(60);

  const layout = agents.data?.layout;
  const list = agents.data?.agents ?? [];
  const chosen = list.find((agent) => agent.id === selected) ?? null;
  const active = list.filter((agent) => agent.state !== "IDLE");

  return (
    <div className="grid gap-4 lg:grid-cols-4">
      <Card
        title="3D Operations Floor"
        subtitle="Positions, walk windows and handoffs come from the same persisted event stream as the task engine."
        className="lg:col-span-3"
      >
        <div className="h-[620px] overflow-hidden rounded-2xl border border-white/10 bg-black">
          {layout ? <Office3D stations={layout.stations} agents={list} selected={selected} onSelect={setSelected} /> : <p className="p-4 text-xs text-slate-400">loading office…</p>}
        </div>
      </Card>

      <div className="space-y-4">
        <Card title="Agent inspector">
          <AgentInspector agent={chosen} />
        </Card>
        <Card title="Active agents" subtitle={`${active.length} of ${list.length} not idle`}>
          <ul className="space-y-1 text-[11px]">
            {active.map((agent) => (
              <li key={agent.id}>
                <button type="button" onClick={() => setSelected(agent.id)} className="w-full rounded-lg border border-white/5 bg-white/[0.02] px-2 py-1 text-left hover:border-amber-400/40">
                  <span className="font-semibold text-slate-200">{agent.name}</span> <span className="text-slate-400">{agent.state}</span>
                  <br />
                  <span className="text-slate-500">{agent.message ?? agent.role}</span>
                </button>
              </li>
            ))}
            {active.length === 0 && <li className="text-slate-400">Everyone is at their station.</li>}
          </ul>
        </Card>
        <Card title="Movement & handoff events">
          <ul className="space-y-1 text-[11px]">
            {events
              .filter((row) => /walk|handoff|agent\./.test(String(row.topic)))
              .slice(0, 14)
              .map((row, index) => (
                <li key={index} className="text-slate-400">
                  <span className="text-sky-300">{String(row.topic)}</span> {String(row.message)}
                </li>
              ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
