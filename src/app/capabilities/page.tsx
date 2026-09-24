"use client";

import { Card, Pill, apiGet, apiPost, usePolling } from "@/components/ui";
import { useState } from "react";

type Capability = { id: string; area: string; label: string; status: string; detail: string; fix?: string; evidence: string[]; required: boolean };
type SystemPayload = {
  doctor: { summary: string; counts: Record<string, number>; capabilities: Capability[]; generatedAt: string; platform: string; tools: number };
  resources: { cpuPercent: number; freeMemMb: number; totalMemMb: number; loadPerCore: number; diskFreeMb: number; pressure: string; explanation: string };
};
type ToolRow = { id: string; title: string; group: string; risk: string; resourceClass: string; agents: string[]; description: string; verificationNote: string };

export default function CapabilitiesPage() {
  const system = usePolling<SystemPayload>("/api/system", 20000);
  const [tools, setTools] = useState<ToolRow[]>([]);

  async function loadTools() {
    const payload = await apiGet<{ tools: ToolRow[] }>("/api/system?section=tools");
    setTools(payload.tools);
  }

  const capabilities = system.data?.doctor.capabilities ?? [];
  const groups = [...new Set(capabilities.map((capability) => capability.area))];

  return (
    <div className="space-y-4">
      <Card
        title="Capability matrix — probed live"
        subtitle={system.data ? `${system.data.doctor.summary} · platform ${system.data.doctor.platform} · ${system.data.doctor.tools} tools` : "probing…"}
        actions={
          <button type="button" onClick={() => void loadTools()} className="rounded-lg border border-white/15 bg-white/5 px-3 py-1 text-[11px] text-slate-200">
            Load tool contracts
          </button>
        }
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {groups.map((group) => (
            <div key={group} className="rounded-xl border border-white/10 bg-black/20 p-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{group}</h3>
              <ul className="mt-2 space-y-2">
                {capabilities
                  .filter((capability) => capability.area === group)
                  .map((capability) => (
                    <li key={capability.id} className="text-[11px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-slate-200">{capability.label}</span>
                        <Pill value={capability.status} />
                      </div>
                      <p className="mt-0.5 text-slate-400">{capability.detail}</p>
                      {capability.fix && <p className="mt-0.5 text-amber-300">fix: {capability.fix}</p>}
                      {capability.required && capability.status !== "AVAILABLE" && <p className="mt-0.5 text-rose-300">required capability gap</p>}
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Evidence for every status" subtitle="raw probe output kept verbatim">
          <ul className="max-h-80 space-y-1 overflow-auto text-[10px] text-slate-400">
            {capabilities.flatMap((capability) =>
              capability.evidence.map((item, index) => (
                <li key={`${capability.id}-${index}`}>
                  <span className="text-slate-500">{capability.id}:</span> {item.slice(0, 220)}
                </li>
              )),
            )}
          </ul>
        </Card>
        <Card title="Tool contracts" subtitle={tools.length ? `${tools.length} tool(s) with risk class and verification method` : "click 'Load tool contracts'"}>
          <ul className="max-h-80 space-y-2 overflow-auto text-[11px]">
            {tools.map((tool) => (
              <li key={tool.id} className="rounded-lg border border-white/5 bg-white/[0.02] p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-100">{tool.id}</span>
                  <Pill value={tool.risk} />
                  <Pill value={tool.resourceClass} />
                </div>
                <p className="mt-1 text-slate-400">{tool.description}</p>
                <p className="mt-1 text-[10px] text-emerald-300/80">verifies: {tool.verificationNote}</p>
                <p className="text-[10px] text-slate-500">agents: {tool.agents.join(", ")}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {system.data && (
        <Card title="Host resources at snapshot time" subtitle={system.data.resources.explanation}>
          <p className="text-xs text-slate-300">
            cpu {system.data.resources.cpuPercent}% · free {system.data.resources.freeMemMb}MB / {system.data.resources.totalMemMb}MB · load/core {system.data.resources.loadPerCore} · disk free {system.data.resources.diskFreeMb}MB · pressure {system.data.resources.pressure}
          </p>
        </Card>
      )}
      <RunSuiteCard />
    </div>
  );
}

function RunSuiteCard() {
  const [state, setState] = useState<string>("idle");
  const [result, setResult] = useState<{ passed: number; failed: number; total: number; ms: number; results: Array<{ area: string; name: string; status: string; detail: string }> } | null>(null);

  async function run() {
    setState("running (executes real tools, browser, ffmpeg, database…)");
    const response = await apiPost<typeof result>("/api/tests", { confirm: "run-acceptance-suite" });
    setResult(response.data as never);
    setState("complete");
  }

  return (
    <Card title="Runtime acceptance suite" subtitle="executes the real system and records PASS / FAIL / UNAVAILABLE per check" actions={
      <button type="button" onClick={() => void run()} className="rounded-lg border border-amber-400/40 bg-amber-400/15 px-3 py-1 text-[11px] font-semibold text-amber-200">
        Run suite
      </button>
    }>
      {result ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-300">
            {result.passed} passed · {result.failed} failed · {result.total} checks · {Math.round(result.ms / 100) / 10}s
          </p>
          <ul className="max-h-64 space-y-1 overflow-auto text-[11px]">
            {result.results.map((check, index) => (
              <li key={index} className="flex gap-2">
                <span className="w-24 shrink-0 text-slate-500">{check.area}</span>
                <span className={`w-24 shrink-0 font-semibold ${check.status === "PASS" ? "text-emerald-300" : check.status === "FAIL" ? "text-rose-300" : "text-amber-300"}`}>{check.status}</span>
                <span className="text-slate-300">{check.name}</span>
                <span className="text-slate-500">{check.detail.slice(0, 160)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-slate-400">{state === "idle" ? "Run the suite to produce a fresh, evidence-backed verification report." : state}</p>
      )}
      <a href="/verification" className="mt-2 inline-block text-[11px] font-semibold text-amber-300 hover:underline">
        full verification page →
      </a>
    </Card>
  );
}
