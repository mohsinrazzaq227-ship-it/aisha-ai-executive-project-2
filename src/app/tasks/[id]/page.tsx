"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { DagGraph, type StepView } from "@/components/DagGraph";
import { Card, Pill, apiPost, usePolling } from "@/components/ui";

type Detail = {
  task: { id: string; request: string; intent: string; engine: string; status: string; planSummary: string; result: string | null; stats: { steps: number; succeeded: number; failed: number; artifacts: number; approvals: number; ms: number } };
  steps: StepView[];
  artifacts: Array<{ id: string; name: string; kind: string; bytes: number; sha256: string; origin: string }>;
  approvals: Array<{ id: string; action: string; risk: string; status: string; target: string }>;
  events: Array<{ id: number; topic: string; message: string; level: string; at: string }>;
  messages: Array<{ id: string; role: string; content: string; engine: string | null }>;
};

export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const taskId = params?.id ?? "";
  const detail = usePolling<Detail>(`/api/tasks/${taskId}`, 2500, Boolean(taskId));
  const [selected, setSelected] = useState<string | null>(null);
  const step = detail.data?.steps.find((row) => row.id === selected) ?? null;

  if (!taskId) return <p className="text-xs text-slate-400">No task id provided.</p>;
  if (!detail.data) return <p className="text-xs text-slate-400">Loading task {taskId}…</p>;

  return (
    <div className="space-y-4">
      <Card
        title={detail.data.task.request}
        subtitle={`${detail.data.task.intent} · ${detail.data.task.engine} · ${detail.data.task.planSummary}`}
        actions={
          <div className="flex items-center gap-2">
            <Pill value={detail.data.task.status} />
            <button
              type="button"
              onClick={async () => {
                await apiPost(`/api/tasks/${taskId}`, { action: "cancel" });
                await detail.refresh();
              }}
              className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200"
            >
              Cancel
            </button>
          </div>
        }
      >
        <DagGraph steps={detail.data.steps} selectedId={selected} onSelect={setSelected} />
        <p className="mt-3 text-[11px] text-slate-400">
          {detail.data.task.stats.succeeded}/{detail.data.task.stats.steps} verified · {detail.data.task.stats.artifacts} artifact(s) · {detail.data.task.stats.approvals} approval(s) ·{" "}
          {Math.round(detail.data.task.stats.ms / 100) / 10}s
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Selected step evidence">
          {step ? (
            <div className="space-y-2 text-[11px] text-slate-300">
              <p className="font-semibold text-slate-100">{step.title}</p>
              <p>
                {step.toolId} · {step.agentId} · <Pill value={step.status} /> <Pill value={step.risk} />
              </p>
              {step.verification && (
                <p className={step.verification.verified ? "text-emerald-300" : "text-rose-300"}>
                  {step.verification.method}: {step.verification.detail}
                </p>
              )}
              <ul className="space-y-1">
                {(step.evidence?.items ?? []).map((item, index) => (
                  <li key={index} className="text-slate-400">
                    <span className="text-slate-500">{item.kind}:</span> {item.detail}
                  </li>
                ))}
              </ul>
              {step.error && <p className="text-rose-300">{step.error}</p>}
            </div>
          ) : (
            <p className="text-[11px] text-slate-400">Select a step above.</p>
          )}
        </Card>

        <Card title={`Artifacts (${detail.data.artifacts.length})`}>
          <ul className="space-y-1 text-[11px]">
            {detail.data.artifacts.map((artifact) => (
              <li key={artifact.id} className="flex items-center justify-between gap-2">
                <a href={`/api/artifacts?id=${artifact.id}`} className="truncate text-amber-200 hover:underline">
                  {artifact.name}
                </a>
                <span className="text-slate-500">
                  {artifact.origin} · {artifact.bytes}B · {artifact.sha256.slice(0, 8)}…
                </span>
              </li>
            ))}
            {!detail.data.artifacts.length && <li className="text-slate-400">none</li>}
          </ul>
          <h3 className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Approvals</h3>
          <ul className="mt-1 space-y-1 text-[11px]">
            {detail.data.approvals.map((row) => (
              <li key={row.id} className="flex items-center gap-2 text-slate-300">
                <Pill value={row.status} />
                <Pill value={row.risk} />
                {row.action} → {row.target}
              </li>
            ))}
            {!detail.data.approvals.length && <li className="text-slate-400">none required</li>}
          </ul>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Task report" subtitle="generated by the supervisor from persisted step rows">
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-white/10 bg-black/30 p-3 text-[11px] text-slate-300">
            {detail.data.task.result ?? "in progress…"}
          </pre>
        </Card>
        <Card title="Task event trail">
          <ul className="max-h-72 space-y-1 overflow-auto text-[11px]">
            {detail.data.events.map((row) => (
              <li key={row.id} className="flex gap-2">
                <span className="w-16 shrink-0 text-slate-500">{new Date(row.at).toLocaleTimeString()}</span>
                <span className={`w-40 shrink-0 truncate ${row.level === "error" ? "text-rose-300" : row.level === "warn" ? "text-amber-300" : "text-sky-300"}`}>{row.topic}</span>
                <span className="text-slate-400">{row.message}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
