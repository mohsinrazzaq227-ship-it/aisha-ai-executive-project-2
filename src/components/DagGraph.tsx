"use client";

import { Pill } from "@/components/ui";

export type StepView = {
  id: string;
  stepIndex: number;
  title: string;
  agentId: string;
  toolId: string;
  status: string;
  risk: string;
  resourceClass: string;
  dependsOn: string[];
  attempts: number;
  maxAttempts: number;
  ms: number;
  error: string | null;
  deferral: string | null;
  verification: { verified: boolean; method: string; detail: string } | null;
  evidence: { items?: Array<{ kind: string; detail: string }> } | null;
};

/**
 * Renders the real task DAG: lanes are computed from dependency depth, so the
 * picture is a projection of persisted rows rather than an illustration.
 */
export function DagGraph({ steps, onSelect, selectedId }: { steps: StepView[]; onSelect?: (id: string) => void; selectedId?: string | null }) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const depth = new Map<string, number>();
  const compute = (id: string, guard = 0): number => {
    if (guard > 20) return 0;
    if (depth.has(id)) return depth.get(id)!;
    const step = byId.get(id);
    if (!step || step.dependsOn.length === 0) {
      depth.set(id, 0);
      return 0;
    }
    const value = 1 + Math.max(...step.dependsOn.map((dep) => (byId.has(dep) ? compute(dep, guard + 1) : 0)));
    depth.set(id, value);
    return value;
  };
  steps.forEach((step) => compute(step.id));

  const lanes = new Map<number, StepView[]>();
  for (const step of steps) {
    const level = depth.get(step.id) ?? 0;
    lanes.set(level, [...(lanes.get(level) ?? []), step]);
  }
  const orderedLevels = [...lanes.keys()].sort((a, b) => a - b);

  return (
    <div className="space-y-3">
      {orderedLevels.map((level) => (
        <div key={level} className="flex flex-wrap items-stretch gap-3">
          <div className="flex w-16 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.02] text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            depth {level}
          </div>
          {lanes.get(level)!.map((step) => {
            const selected = selectedId === step.id;
            return (
              <button
                key={step.id}
                type="button"
                onClick={() => onSelect?.(step.id)}
                className={`min-w-[210px] max-w-[300px] flex-1 rounded-xl border p-3 text-left transition ${
                  selected ? "border-amber-400/60 bg-amber-400/10" : "border-white/10 bg-white/[0.03] hover:border-white/25"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-100">{step.title}</span>
                  <Pill value={step.status} />
                </div>
                <p className="mt-1 text-[11px] text-slate-400">
                  {step.toolId} · {step.agentId}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  <Pill value={step.risk} />
                  <Pill value={step.resourceClass} />
                  {step.verification && (
                    <span className={`text-[10px] font-semibold ${step.verification.verified ? "text-emerald-300" : "text-rose-300"}`}>
                      {step.verification.verified ? "✓ verified" : "✗ verification failed"}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-[10px] text-slate-500">
                  {step.dependsOn.length ? `depends on ${step.dependsOn.length}` : "independent branch"} · attempt {step.attempts}/{step.maxAttempts} · {step.ms}ms
                </p>
                {step.deferral && <p className="mt-1 text-[10px] text-amber-300">deferred: {step.deferral}</p>}
                {step.error && <p className="mt-1 text-[10px] text-rose-300">{step.error.slice(0, 140)}</p>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
