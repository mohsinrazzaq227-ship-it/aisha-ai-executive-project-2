"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { DagGraph, type StepView } from "@/components/DagGraph";
import { Card, Pill, StatusDot, apiGet, apiPost, useEventStream, usePolling } from "@/components/ui";

type TaskRow = {
  id: string;
  request: string;
  intent: string;
  engine: string;
  status: string;
  risk: string;
  planSummary: string;
  stats: { steps: number; succeeded: number; failed: number; artifacts: number; approvals: number; ms: number };
  result: string | null;
  error: string | null;
  createdAt: string;
};

type TaskDetail = {
  task: TaskRow;
  steps: StepView[];
  approvals: Array<{ id: string; action: string; target: string; risk: string; status: string; reason: string; actionHash: string; expiresAt: string }>;
  artifacts: Array<{ id: string; name: string; kind: string; bytes: number; sha256: string; origin: string; path: string }>;
  events: Array<{ id: number; topic: string; message: string; level: string; at: string }>;
  messages: Array<{ id: string; role: string; content: string; engine: string | null; at: string }>;
};

type ResourceSnapshot = { cpuPercent: number; freeMemMb: number; totalMemMb: number; loadPerCore: number; diskFreeMb: number; pressure: string; explanation: string; activeSteps: number; heavyActive: number; cpuModel: string; cpuCount: number };
type SystemPayload = { doctor: { summary: string; capabilities: Array<{ id: string; label: string; status: string; detail: string }> }; resources: ResourceSnapshot; tools: number };

type AgentView = { id: string; name: string; role: string; state: string; message: string | null; mood: string; color: string; tier: string };

const SUGGESTIONS = [
  "Research the local AI market and prepare an executive report as PDF",
  "Run host diagnostics and check the process list",
  "Create a 3-scene deterministic video with captions",
  "Browse https://example.com and screenshot it",
  "Analyse workspace/datasets/selftest.csv and summarise the price column",
  "Scan the workspace and report on the security posture",
];

export function ExecutiveConsole() {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Array<{ role: string; content: string; engine?: string | null }>>([]);

  const tasks = usePolling<{ tasks: TaskRow[] }>("/api/tasks", 3000);
  const approvals = usePolling<{ approvals: Array<{ id: string; taskId: string; action: string; target: string; risk: string; status: string; reason: string; actionHash: string; expiresAt: string; stepId: string }>; pending: number }>("/api/approvals", 2000);
  const agents = usePolling<{ agents: AgentView[] }>("/api/agents", 2500);
  const system = usePolling<SystemPayload>("/api/system", 15000);
  const detail = usePolling<TaskDetail>(selectedTask ? `/api/tasks/${selectedTask}` : "/api/tasks/none", 2000, Boolean(selectedTask));
  const events = useEventStream(80);

  useEffect(() => {
    if (!selectedTask && tasks.data?.tasks?.length) setSelectedTask(tasks.data.tasks[0].id);
  }, [selectedTask, tasks.data]);

  const taskList = tasks.data?.tasks ?? [];
  const pendingApprovals = (approvals.data?.approvals ?? []).filter((row) => row.status === "PENDING");
  const ollama = useMemo(() => system.data?.doctor.capabilities.find((capability) => capability.id === "ollama"), [system.data]);

  async function send(command?: string) {
    const text = (command ?? input).trim();
    if (!text || busy) return;
    setBusy(true);
    setNotice(null);
    setTranscript((current) => [...current, { role: "user", content: text }]);
    setInput("");
    try {
      const result = await apiPost<{ type: string; task?: TaskRow; answer?: string; engine?: string; note?: string }>("/api/chat", { message: text });
      if (result.data.task) {
        setSelectedTask(result.data.task.id);
        setTranscript((current) => [...current, { role: "assistant", content: `Task ${result.data.task!.id} created. ${result.data.note ?? ""}`, engine: result.data.task!.engine }]);
        setNotice({ tone: "ok", text: `Task created (${result.data.task.intent} intent). Watch the graph below.` });
      } else {
        setTranscript((current) => [...current, { role: "assistant", content: result.data.answer ?? "no answer", engine: result.data.engine }]);
      }
      await tasks.refresh();
    } catch (error) {
      setNotice({ tone: "error", text: String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, decision: "GRANTED" | "DENIED") {
    const result = await apiPost<{ ok: boolean; detail: string }>("/api/approvals", { id, decision, actor: "operator" });
    setNotice({ tone: result.data.ok ? "ok" : "error", text: result.data.detail });
    await approvals.refresh();
  }

  async function taskAction(id: string, action: "cancel" | "retry") {
    const result = await apiPost<{ detail?: string; note?: string }>(`/api/tasks/${id}`, { action });
    setNotice({ tone: "warn", text: result.data.detail ?? result.data.note ?? `${action} requested` });
    await tasks.refresh();
    if (action === "retry") await tasks.refresh();
  }

  const step = detail.data?.steps.find((row) => row.id === selectedStep) ?? null;

  return (
    <div className="space-y-4">
      <Card
        title="Command AISHA"
        subtitle="AISHA plans, delegates, gates risk, verifies and reports. Nothing is claimed without evidence."
        actions={
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>engine</span>
            <Pill value={ollama?.status ?? "UNKNOWN"} title={ollama?.detail} />
            <span className="hidden md:inline">{system.data?.tools ?? 0} tools</span>
          </div>
        }
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="Tell AISHA the outcome you want…"
            className="flex-1 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-amber-400/50"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy}
            className="rounded-xl border border-amber-400/40 bg-amber-400/15 px-4 py-2 text-sm font-semibold text-amber-200 transition hover:bg-amber-400/25 disabled:opacity-50"
          >
            {busy ? "planning…" : "Dispatch"}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => void send(suggestion)}
              className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] text-slate-300 hover:border-white/30"
            >
              {suggestion}
            </button>
          ))}
        </div>
        {notice && (
          <p className={`mt-3 text-xs ${notice.tone === "ok" ? "text-emerald-300" : notice.tone === "warn" ? "text-amber-300" : "text-rose-300"}`}>{notice.text}</p>
        )}
        {transcript.length > 0 && (
          <div className="mt-3 max-h-44 space-y-2 overflow-auto rounded-xl border border-white/10 bg-black/30 p-3">
            {transcript.map((line, index) => (
              <p key={index} className={`text-xs ${line.role === "user" ? "text-slate-200" : "text-amber-200"}`}>
                <span className="mr-2 font-semibold uppercase tracking-wide text-slate-500">{line.role}</span>
                {line.content}
                {line.engine && <span className="ml-2 text-[10px] text-slate-500">[{line.engine}]</span>}
              </p>
            ))}
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Resources & capability truth" subtitle={system.data?.resources.explanation} className="lg:col-span-1">
          <div className="space-y-2 text-xs text-slate-300">
            <Row label="pressure" value={system.data?.resources.pressure ?? "…"} />
            <Row label="cpu" value={`${system.data?.resources.cpuPercent ?? 0}% (${system.data?.resources.cpuCount ?? 0} cores)`} />
            <Row label="free RAM" value={`${system.data?.resources.freeMemMb ?? 0}MB / ${system.data?.resources.totalMemMb ?? 0}MB`} />
            <Row label="load / core" value={String(system.data?.resources.loadPerCore ?? 0)} />
            <Row label="disk free" value={`${system.data?.resources.diskFreeMb ?? 0}MB`} />
            <Row label="active / heavy steps" value={`${system.data?.resources.activeSteps ?? 0} / ${system.data?.resources.heavyActive ?? 0}`} />
            <p className="pt-1 text-[11px] text-slate-400">{system.data?.doctor.summary}</p>
            <Link href="/capabilities" className="inline-block pt-1 text-[11px] font-semibold text-amber-300 hover:underline">
              full capability matrix →
            </Link>
          </div>
        </Card>

        <Card
          title="Human-in-the-loop approvals"
          subtitle={pendingApprovals.length ? `${pendingApprovals.length} action(s) waiting on you` : "no pending decisions"}
          className="lg:col-span-2"
        >
          {pendingApprovals.length === 0 ? (
            <p className="text-xs text-slate-400">Nothing is waiting. HIGH/CRITICAL actions always stop here before execution.</p>
          ) : (
            <ul className="space-y-3">
              {pendingApprovals.map((row) => (
                <li key={row.id} className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill value={row.risk} />
                    <span className="text-xs font-semibold text-slate-100">{row.action}</span>
                    <span className="text-xs text-slate-400">→ {row.target}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">{row.reason}</p>
                  <p className="mt-1 text-[10px] text-slate-500">
                    action hash {row.actionHash.slice(0, 16)}… · expires {new Date(row.expiresAt).toLocaleTimeString()}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button type="button" onClick={() => void decide(row.id, "GRANTED")} className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1 text-[11px] font-semibold text-emerald-200">
                      Approve
                    </button>
                    <button type="button" onClick={() => void decide(row.id, "DENIED")} className="rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 py-1 text-[11px] font-semibold text-rose-200">
                      Deny
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card title="Tasks" subtitle="persisted graph state" className="lg:col-span-2">
          <ul className="max-h-[420px] space-y-2 overflow-auto pr-1">
            {taskList.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedTask(task.id);
                    setSelectedStep(null);
                  }}
                  className={`w-full rounded-xl border p-3 text-left transition ${selectedTask === task.id ? "border-amber-400/50 bg-amber-400/10" : "border-white/10 bg-white/[0.02] hover:border-white/25"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="line-clamp-2 text-xs font-medium text-slate-100">{task.request}</span>
                    <Pill value={task.status} />
                  </div>
                  <p className="mt-1 text-[10px] text-slate-400">
                    {task.intent} · {task.engine} · {task.stats.succeeded}/{task.stats.steps} verified · {task.stats.artifacts} artifact(s) · {Math.round(task.stats.ms / 100) / 10}s
                  </p>
                </button>
              </li>
            ))}
            {taskList.length === 0 && <li className="text-xs text-slate-400">No tasks yet. Dispatch a command above.</li>}
          </ul>
        </Card>

        <Card
          title={detail.data?.task.request?.slice(0, 70) ?? "Task graph"}
          subtitle={detail.data ? `${detail.data.task.intent} · ${detail.data.task.engine} · ${detail.data.task.planSummary}` : "select a task"}
          className="lg:col-span-3"
          actions={
            detail.data && (
              <div className="flex gap-2">
                <button type="button" onClick={() => void taskAction(detail.data!.task.id, "cancel")} className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">
                  Cancel (verified)
                </button>
                <button type="button" onClick={() => void taskAction(detail.data!.task.id, "retry")} className="rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-[11px] text-slate-200">
                  Retry graph
                </button>
              </div>
            )
          }
        >
          {!detail.data ? (
            <p className="text-xs text-slate-400">No task selected.</p>
          ) : (
            <div className="space-y-3">
              <DagGraph steps={detail.data.steps} selectedId={selectedStep} onSelect={(id) => setSelectedStep(id)} />
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Evidence & verification</h3>
                  {step ? (
                    <div className="mt-2 space-y-2 text-[11px] text-slate-300">
                      <p className="font-semibold text-slate-100">{step.title}</p>
                      <p>
                        tool <span className="text-slate-100">{step.toolId}</span> · agent {step.agentId} · <Pill value={step.status} />
                      </p>
                      {step.verification ? (
                        <p className={step.verification.verified ? "text-emerald-300" : "text-rose-300"}>
                          verification: {step.verification.method} — {step.verification.detail}
                        </p>
                      ) : (
                        <p className="text-amber-300">no verification recorded yet</p>
                      )}
                      <ul className="space-y-1">
                        {(step.evidence?.items ?? []).slice(0, 6).map((item, index) => (
                          <li key={index} className="text-slate-400">
                            <span className="text-slate-500">{item.kind}:</span> {item.detail.slice(0, 200)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="mt-2 text-[11px] text-slate-400">Select a step in the graph to inspect its evidence.</p>
                  )}
                </div>
                <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Artifacts ({detail.data.artifacts.length})</h3>
                  <ul className="mt-2 space-y-1 text-[11px]">
                    {detail.data.artifacts.slice(0, 8).map((artifact) => (
                      <li key={artifact.id} className="flex items-center justify-between gap-2 text-slate-300">
                        <a href={`/api/artifacts?id=${artifact.id}`} className="truncate hover:text-amber-300">
                          {artifact.name}
                        </a>
                        <span className="shrink-0 text-[10px] text-slate-500">
                          {artifact.origin} · {artifact.bytes}B · {artifact.sha256.slice(0, 8)}…
                        </span>
                      </li>
                    ))}
                    {detail.data.artifacts.length === 0 && <li className="text-slate-400">none registered yet</li>}
                  </ul>
                </div>
              </div>
              {detail.data.task.result && (
                <pre className="max-h-56 overflow-auto rounded-xl border border-white/10 bg-black/30 p-3 text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap">
                  {detail.data.task.result}
                </pre>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card title="Agent activity" subtitle={`${agents.data?.agents.filter((a) => a.state !== "IDLE").length ?? 0} active · click a station in the 3D office`} className="lg:col-span-2">
          <ul className="max-h-64 space-y-1 overflow-auto text-[11px]">
            {(agents.data?.agents ?? []).map((agent) => (
              <li key={agent.id} className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-2 py-1">
                <StatusDot state={agent.state} />
                <span className="w-28 shrink-0 truncate font-medium text-slate-200">{agent.name}</span>
                <span className="w-32 shrink-0 truncate text-slate-400">{agent.state}</span>
                <span className="truncate text-slate-500">{agent.message ?? agent.role}</span>
              </li>
            ))}
          </ul>
          <Link href="/office" className="mt-2 inline-block text-[11px] font-semibold text-amber-300 hover:underline">
            open the 3D office →
          </Link>
        </Card>

        <Card title="Authoritative event stream" subtitle="every subsystem writes here; the office, tasks and logs read the same rows" className="lg:col-span-3">
          <ul className="max-h-64 space-y-1 overflow-auto text-[11px]">
            {events.slice(0, 60).map((row, index) => (
              <li key={`${row.id}-${index}`} className="flex gap-2">
                <span className="shrink-0 text-slate-500">{new Date(String(row.at)).toLocaleTimeString()}</span>
                <span className={`w-40 shrink-0 truncate font-semibold ${String(row.level) === "error" ? "text-rose-300" : String(row.level) === "warn" ? "text-amber-300" : String(row.level) === "success" ? "text-emerald-300" : "text-sky-300"}`}>
                  {String(row.topic)}
                </span>
                <span className="text-slate-400">{String(row.message)}</span>
              </li>
            ))}
            {events.length === 0 && <li className="text-slate-400">waiting for events…</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex items-center justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-slate-200">{value}</span>
    </p>
  );
}
