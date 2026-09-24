"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentRecord, ApprovalRecord, DoctorReport, LiveEvent, ProviderRecord, TaskArtifact, TaskRecord, UploadRecord } from "@/components/useExecutive";

const STATUS_STYLE: Record<string, string> = {
  QUEUED: "text-slate-300 border-slate-500/40",
  PLANNING: "text-cyan-200 border-cyan-400/40",
  RUNNING: "text-cyan-100 border-cyan-400/60",
  WAITING_APPROVAL: "text-amber-200 border-amber-400/50",
  PAUSED: "text-yellow-200 border-yellow-400/40",
  COMPLETED: "text-emerald-200 border-emerald-400/50",
  FAILED: "text-red-200 border-red-400/50",
  CANCELLED: "text-slate-400 border-slate-500/40",
  PENDING: "text-slate-300 border-slate-500/30",
  WALKING: "text-amber-200 border-amber-400/40",
  WAITING_APPROVAL_STEP: "text-amber-200 border-amber-400/40",
  ERROR: "text-red-200 border-red-400/50",
  SKIPPED: "text-slate-400 border-slate-600/40",
};

function Pill({ label, tone }: { label: string; tone?: string }) {
  return <span className={`rounded-md border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] ${tone ?? STATUS_STYLE[label] ?? "border-white/15 text-white/70"}`}>{label.replace(/_/g, " ")}</span>;
}

export function TaskPanel({ tasks, onControl }: { tasks: TaskRecord[]; onControl: (taskId: string, action: "pause" | "resume" | "cancel" | "retry") => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const active = tasks.filter((task) => !["COMPLETED", "FAILED", "CANCELLED"].includes(task.status));
  const done = tasks.filter((task) => ["COMPLETED", "FAILED", "CANCELLED"].includes(task.status));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] uppercase tracking-[0.2em] text-white/50">Active tasks ({active.length})</h2>
        <span className="text-[10px] text-white/40">Multitasking: each task owns its run directory and its own agents lock</span>
      </div>
      {active.length === 0 && <p className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-4 text-[12px] text-white/50">No active tasks. Send a request to the Master Supervisor and the office will start working.</p>}
      {active.map((task) => (
        <TaskCard key={task.id} task={task} expanded={openId === task.id} onToggle={() => setOpenId(openId === task.id ? null : task.id)} onControl={onControl} />
      ))}
      {done.length > 0 && (
        <>
          <h2 className="pt-2 text-[11px] uppercase tracking-[0.2em] text-white/40">History</h2>
          {done.slice(0, 8).map((task) => (
            <TaskCard key={task.id} task={task} expanded={openId === task.id} onToggle={() => setOpenId(openId === task.id ? null : task.id)} onControl={onControl} />
          ))}
        </>
      )}
    </div>
  );
}

function TaskCard({ task, expanded, onToggle, onControl }: { task: TaskRecord; expanded: boolean; onToggle: () => void; onControl: (taskId: string, action: "pause" | "resume" | "cancel" | "retry") => void }) {
  const done = task.steps.filter((step) => step.status === "COMPLETED").length;
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <button type="button" onClick={onToggle} className="w-full text-left">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[13px] font-medium text-white/90">{task.title}</p>
            <p className="text-[11px] text-white/45">
              {task.currentAgent ? `${task.currentAgent.glyph} ${task.currentAgent.name}` : "—"} · {done}/{task.steps.length} steps · planner {task.plannerEngine}
            </p>
          </div>
          <Pill label={task.status} />
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-fuchsia-400 transition-all" style={{ width: `${task.status === "COMPLETED" ? 100 : task.progress}%` }} />
        </div>
      </button>

      {expanded && (
        <div className="mt-3 space-y-3 text-[12px]">
          <ol className="space-y-1.5">
            {task.steps.map((step) => (
              <li key={step.id} className="rounded-lg border border-white/10 bg-black/20 px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-white/85">
                    <span className="mr-1 text-white/40">{String(step.index + 1).padStart(2, "0")}</span>
                    {step.title}
                  </span>
                  <span className="flex items-center gap-1">
                    <Pill label={step.risk} tone={step.risk === "HIGH" ? "border-red-400/50 text-red-200" : step.risk === "MEDIUM" ? "border-amber-400/40 text-amber-200" : "border-emerald-400/40 text-emerald-200"} />
                    <Pill label={step.status} />
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-white/45">
                  {step.agentName} · <code className="text-cyan-200/80">{step.toolId}</code>
                  {step.requiresApproval ? " · approval gated" : ""}
                </p>
                {step.summary && <p className="mt-1 text-[11px] text-white/60">{step.summary.slice(0, 260)}</p>}
                {step.error && <p className="mt-1 text-[11px] text-red-300">ERROR: {step.error}</p>}
              </li>
            ))}
          </ol>

          {task.finalAnswer && (
            <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/5 p-2.5">
              <p className="mb-1 text-[10px] uppercase tracking-[0.16em] text-emerald-200/80">Supervisor report</p>
              <pre className="whitespace-pre-wrap text-[11px] text-emerald-100/90">{task.finalAnswer}</pre>
            </div>
          )}

          {task.artifacts.length > 0 && (
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-[0.16em] text-white/40">Artifacts ({task.artifacts.length})</p>
              <ul className="space-y-1">
                {task.artifacts.map((artifact) => (
                  <li key={artifact.id} className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/20 px-2 py-1.5">
                    <span className="truncate text-[11px] text-white/80">
                      {artifact.kind} · {artifact.name} {artifact.validated && <span className="text-emerald-300">validated</span>}
                    </span>
                    <a href={`/api/artifacts?download=${artifact.id}`} target="_blank" rel="noreferrer" className="rounded border border-cyan-400/40 px-2 py-0.5 text-[10px] text-cyan-200 hover:bg-cyan-500/10">
                      open
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {task.status === "RUNNING" && (
              <button type="button" onClick={() => onControl(task.id, "pause")} className="rounded-lg border border-white/20 px-2.5 py-1 text-[11px] text-white/80 hover:bg-white/10">
                Pause
              </button>
            )}
            {task.status === "PAUSED" && (
              <button type="button" onClick={() => onControl(task.id, "resume")} className="rounded-lg border border-cyan-400/40 px-2.5 py-1 text-[11px] text-cyan-200 hover:bg-cyan-500/10">
                Resume
              </button>
            )}
            {["FAILED", "CANCELLED"].includes(task.status) && (
              <button type="button" onClick={() => onControl(task.id, "retry")} className="rounded-lg border border-emerald-400/40 px-2.5 py-1 text-[11px] text-emerald-200 hover:bg-emerald-500/10">
                Retry failed steps
              </button>
            )}
            {!["COMPLETED", "CANCELLED"].includes(task.status) && (
              <button type="button" onClick={() => onControl(task.id, "cancel")} className="rounded-lg border border-red-400/40 px-2.5 py-1 text-[11px] text-red-200 hover:bg-red-500/10">
                Cancel (kills host processes)
              </button>
            )}
            <span className="ml-auto text-[10px] text-white/35">run {task.runId}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function AgentRoster({ agents, selectedAgentId, onSelect }: { agents: AgentRecord[]; selectedAgentId: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="space-y-2">
      <h2 className="text-[11px] uppercase tracking-[0.2em] text-white/50">Team ({agents.length} agents)</h2>
      <div className="max-h-[320px] space-y-1.5 overflow-y-auto pr-1">
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => onSelect(agent.id)}
            className={`w-full rounded-xl border px-2.5 py-2 text-left transition ${selectedAgentId === agent.id ? "border-cyan-400/50 bg-cyan-500/10" : "border-white/10 bg-white/[0.02] hover:bg-white/[0.06]"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-medium text-white/90">
                <span className="mr-1">{agent.glyph}</span>
                {agent.name}
              </span>
              <Pill label={agent.state} />
            </div>
            <p className="text-[10px] text-white/45">{agent.role} · {agent.stationLabel} · max risk {agent.riskProfile}</p>
            {agent.lastMessage && <p className="mt-1 line-clamp-2 text-[10px] text-cyan-100/70">{agent.lastMessage}</p>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ActivityFeed({ events }: { events: LiveEvent[] }) {
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => (filter ? events.filter((event) => event.type.includes(filter) || event.message.toLowerCase().includes(filter.toLowerCase())) : events), [events, filter]);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[11px] uppercase tracking-[0.2em] text-white/50">Activity stream ({events.length})</h2>
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="filter…"
          className="w-28 rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-[10px] text-white outline-none focus:border-cyan-400/50"
        />
      </div>
      <div className="max-h-[280px] space-y-1 overflow-y-auto pr-1 font-mono text-[10.5px]">
        {filtered
          .slice()
          .reverse()
          .slice(0, 160)
          .map((event, index) => (
            <div key={`${event.id ?? index}-${event.ts}`} className="rounded border border-white/5 bg-black/25 px-2 py-1">
              <span className="text-white/30">{new Date(event.ts).toLocaleTimeString()}</span>{" "}
              <span className={event.severity === "error" ? "text-red-300" : event.severity === "success" ? "text-emerald-300" : event.severity === "warn" ? "text-amber-300" : "text-cyan-300"}>{event.type}</span>
              {event.agentId && <span className="text-fuchsia-300/80"> [{event.agentId}]</span>}
              <span className="text-white/70"> {event.message.slice(0, 260)}</span>
            </div>
          ))}
        {filtered.length === 0 && <p className="text-white/40">No events yet.</p>}
      </div>
    </div>
  );
}

export function ProviderPanel({ providers }: { providers: ProviderRecord[] }) {
  const tone: Record<string, string> = {
    AVAILABLE: "border-emerald-400/40 text-emerald-200",
    CLIENT_SIDE: "border-cyan-400/40 text-cyan-200",
    DISABLED: "border-white/15 text-white/50",
    UNAVAILABLE: "border-amber-400/40 text-amber-200",
    ERROR: "border-red-400/50 text-red-200",
    OPTIONAL_UNTESTED: "border-fuchsia-400/40 text-fuchsia-200",
  };
  return (
    <div className="space-y-2">
      <h2 className="text-[11px] uppercase tracking-[0.2em] text-white/50">Providers &amp; capabilities</h2>
      <div className="max-h-[260px] space-y-1.5 overflow-y-auto pr-1">
        {providers.map((provider) => (
          <div key={provider.id} className="rounded-xl border border-white/10 bg-white/[0.02] px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11.5px] text-white/85">{provider.label}</span>
              <Pill label={provider.status} tone={tone[provider.status]} />
            </div>
            <p className="mt-1 text-[10.5px] leading-snug text-white/50">{provider.detail}</p>
            <p className="mt-0.5 text-[9.5px] uppercase tracking-[0.14em] text-white/30">{provider.kind} · {provider.local ? "local" : "network"} · {provider.cost}</p>
          </div>
        ))}
        {providers.length === 0 && <p className="text-[11px] text-white/40">Probing providers…</p>}
      </div>
    </div>
  );
}

export function DoctorPanel({ doctor, onRun, running }: { doctor: DoctorReport | null; onRun: () => void; running: boolean }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] uppercase tracking-[0.2em] text-white/50">AI-EXECUTIVE Doctor</h2>
        <button type="button" onClick={onRun} disabled={running} className="rounded-lg border border-cyan-400/40 px-2.5 py-1 text-[11px] text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-40">
          {running ? "Running…" : "Run diagnostics"}
        </button>
      </div>
      {doctor ? (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-1.5 text-center text-[10px]">
            <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/5 px-2 py-1 text-emerald-200">{doctor.summary.pass} PASS</div>
            <div className="rounded-lg border border-amber-400/30 bg-amber-500/5 px-2 py-1 text-amber-200">{doctor.summary.warning} WARN</div>
            <div className="rounded-lg border border-red-400/30 bg-red-500/5 px-2 py-1 text-red-200">{doctor.summary.fail} FAIL</div>
          </div>
          <p className="text-[10px] text-white/45">
            {doctor.host.platform} {doctor.host.release} · {doctor.host.cpus} cores · {doctor.host.totalMemory} · {doctor.durationMs} ms
          </p>
          <div className="max-h-[240px] space-y-1 overflow-y-auto pr-1">
            {doctor.checks.map((check) => (
              <div key={check.id} className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-white/85">{check.name}</span>
                  <Pill
                    label={check.status}
                    tone={
                      check.status === "PASS"
                        ? "border-emerald-400/40 text-emerald-200"
                        : check.status === "FAIL"
                          ? "border-red-400/50 text-red-200"
                          : check.status === "WARNING"
                            ? "border-amber-400/40 text-amber-200"
                            : check.status === "CLIENT_SIDE"
                              ? "border-cyan-400/40 text-cyan-200"
                              : "border-white/15 text-white/50"
                    }
                  />
                </div>
                <p className="mt-0.5 text-[10px] leading-snug text-white/50">{check.detail}</p>
                {check.action && <p className="mt-0.5 text-[10px] text-cyan-200/80">→ {check.action}</p>}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-white/40">Doctor has not run in this session. It verifies the real environment: binaries, providers, filesystem permissions, database, network reachability and renderer.</p>
      )}
    </div>
  );
}

export function UploadPanel({
  uploads,
  limits,
  onUpload,
  onRemove,
  selected,
  onToggleSelect,
}: {
  uploads: UploadRecord[];
  limits: { maxBytes: number; allowedExtensions: string[] } | null;
  onUpload: (files: FileList | File[]) => Promise<unknown>;
  onRemove: (id: string) => void;
  selected: string[];
  onToggleSelect: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <div className="space-y-2">
      <h2 className="text-[11px] uppercase tracking-[0.2em] text-white/50">Uploads {selected.length > 0 ? `· ${selected.length} attached to next request` : ""}</h2>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (event.dataTransfer.files.length > 0) void onUpload(event.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-xl border border-dashed px-3 py-4 text-center text-[11px] transition ${dragging ? "border-cyan-400/70 bg-cyan-500/10 text-cyan-100" : "border-white/20 bg-white/[0.02] text-white/55 hover:bg-white/[0.05]"}`}
      >
        Drag &amp; drop files here or click to choose
        <p className="mt-1 text-[10px] text-white/35">
          Backend-validated · {limits ? `max ${(limits.maxBytes / 1024 / 1024).toFixed(0)} MB` : "limits loading"} · {limits?.allowedExtensions.slice(0, 8).join(" ")} …
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files && event.target.files.length > 0) void onUpload(event.target.files);
            event.target.value = "";
          }}
        />
      </div>
      <div className="max-h-[200px] space-y-1 overflow-y-auto pr-1">
        {uploads.map((upload) => (
          <div key={upload.id} className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <label className="flex min-w-0 items-center gap-2 text-[11px] text-white/85">
                <input type="checkbox" checked={selected.includes(upload.id)} onChange={() => onToggleSelect(upload.id)} className="accent-cyan-400" />
                <span className="truncate">{upload.originalName}</span>
              </label>
              <span className="flex items-center gap-1">
                <Pill label={upload.status} tone={upload.status === "EXTRACTED" ? "border-emerald-400/40 text-emerald-200" : "border-white/15 text-white/60"} />
                <button type="button" onClick={() => onRemove(upload.id)} className="text-[10px] text-red-300 hover:text-red-200">
                  remove
                </button>
              </span>
            </div>
            <p className="mt-0.5 text-[10px] text-white/40">
              {upload.sizeHuman} · {upload.mime} · sha256 {upload.sha256.slice(0, 12)}… · backend {upload.exists ? "confirmed on disk" : "file missing"}
            </p>
          </div>
        ))}
        {uploads.length === 0 && <p className="text-[11px] text-white/40">No uploads yet.</p>}
      </div>
    </div>
  );
}

export function AgentInspector({ agent, quality, setQuality }: { agent: AgentRecord | null; quality: string; setQuality: (mode: "HIGH" | "BALANCED" | "LOW") => void }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] uppercase tracking-[0.2em] text-white/50">3D office quality</h2>
        <div className="flex gap-1">
          {(["HIGH", "BALANCED", "LOW"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setQuality(mode)}
              className={`rounded-lg border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] ${quality === mode ? "border-cyan-400/60 bg-cyan-500/15 text-cyan-100" : "border-white/15 text-white/50 hover:bg-white/5"}`}
            >
              {mode === "HIGH" ? "High quality" : mode === "BALANCED" ? "Balanced" : "Low power"}
            </button>
          ))}
        </div>
      </div>
      {agent ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <div className="flex items-center justify-between">
            <p className="text-[13px] text-white/90">
              <span className="mr-1">{agent.glyph}</span>
              {agent.name} <span className="text-white/40">· {agent.role}</span>
            </p>
            <Pill label={agent.state} />
          </div>
          <p className="mt-1 text-[11px] text-white/55">{agent.brief}</p>
          <p className="mt-2 text-[10px] uppercase tracking-[0.14em] text-white/35">Callsign {agent.callsign} · station {agent.stationLabel} · max risk {agent.riskProfile}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {agent.capabilities.map((capability) => (
              <span key={capability} className="rounded border border-white/10 bg-black/25 px-1.5 py-0.5 text-[10px] text-white/65">
                {capability}
              </span>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {agent.tools.map((tool) => (
              <code key={tool} className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-200">
                {tool}
              </code>
            ))}
          </div>
          {agent.lastMessage && <p className="mt-2 rounded-lg border border-cyan-300/20 bg-black/30 px-2 py-1.5 text-[11px] text-cyan-100/85">“{agent.lastMessage}”</p>}
        </div>
      ) : (
        <p className="text-[11px] text-white/40">Click an agent in the 3D office to inspect its registry entry.</p>
      )}
    </div>
  );
}


export function ArtifactsPanel({
  artifacts,
  tasks,
}: {
  artifacts: (TaskArtifact & { taskTitle?: string })[];
  tasks: TaskRecord[];
}) {
  const [kind, setKind] = useState<string>("");
  const taskTitles = new Map(tasks.map((task) => [task.id, task.title]));
  const kinds = Array.from(new Set(artifacts.map((artifact) => artifact.kind)));
  const visible = kind ? artifacts.filter((artifact) => artifact.kind === kind) : artifacts;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[11px] uppercase tracking-[0.2em] text-white/50">Artifacts ({artifacts.length})</h2>
        <select value={kind} onChange={(event) => setKind(event.target.value)} className="rounded border border-white/15 bg-black/40 px-1.5 py-0.5 text-[10px] text-white">
          <option value="">all kinds</option>
          {kinds.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
      </div>
      <div className="max-h-[320px] space-y-1.5 overflow-y-auto pr-1">
        {visible.map((artifact) => (
          <div key={artifact.id} className="rounded-lg border border-white/10 bg-black/25 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[11px] text-white/85">{artifact.name}</span>
              <span className="flex items-center gap-1">
                <Pill label={artifact.kind} tone="border-white/15 text-white/60" />
                {artifact.validated && <Pill label="validated" tone="border-emerald-400/40 text-emerald-200" />}
              </span>
            </div>
            <p className="mt-0.5 text-[10px] text-white/40">
              {(artifact.size / 1024).toFixed(1)} KB · {artifact.mime} · task: {taskTitles.get(artifact.taskId ?? "") ?? artifact.taskId?.slice(0, 14) ?? "—"}
            </p>
            <div className="mt-1 flex gap-2 text-[10px]">
              <a href={`/api/artifacts?download=${artifact.id}`} target="_blank" rel="noreferrer" className="rounded border border-cyan-400/40 px-2 py-0.5 text-cyan-200 hover:bg-cyan-500/10">
                open / view
              </a>
              <a href={`/api/artifacts?download=${artifact.id}&attachment=1`} className="rounded border border-white/20 px-2 py-0.5 text-white/70 hover:bg-white/10">
                download
              </a>
              <span className="text-white/25">{artifact.relPath}</span>
            </div>
          </div>
        ))}
        {visible.length === 0 && <p className="text-[11px] text-white/40">No artifacts produced yet. Reports, videos, frames, captions, screenshots, research bundles and validation reports all appear here with checksums in the run manifest.</p>}
      </div>
    </div>
  );
}

export function ApprovalsQueue({
  approvals,
  onDecide,
}: {
  approvals: ApprovalRecord[];
  onDecide: (approvalId: string, decision: "APPROVE_ONCE" | "APPROVE_SESSION" | "DENY", options?: { note?: string }) => Promise<boolean>;
}) {
  const pending = approvals.filter((approval) => approval.status === "PENDING" && !approval.expired);
  const history = approvals.filter((approval) => approval.status !== "PENDING" || approval.expired).slice(0, 25);
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-[11px] uppercase tracking-[0.2em] text-white/50">Approval queue ({pending.length})</h2>
        {pending.length === 0 && <p className="mt-1 text-[11px] text-white/40">Nothing is waiting for you. Tasks stop here automatically before any MEDIUM/HIGH risk action.</p>}
        <div className="mt-2 space-y-2">
          {pending.map((approval) => (
            <div key={approval.id} className="rounded-xl border border-amber-400/30 bg-amber-500/5 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-white/90">
                  {approval.agent.glyph} {approval.agent.name} · {approval.approvalLabel}
                </span>
                <Pill label={approval.risk} tone={approval.risk === "HIGH" ? "border-red-400/50 text-red-200" : "border-amber-400/40 text-amber-200"} />
              </div>
              <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/40 p-2 text-[10.5px] text-cyan-100">{JSON.stringify(approval.action, null, 2)}</pre>
              <p className="mt-1 text-[10px] text-white/45">
                target: {approval.target ?? "n/a"} · hash {approval.parametersHash.slice(0, 16)}… · expires {new Date(approval.expiresAt).toLocaleTimeString()}
              </p>
              <div className="mt-1.5 flex gap-1.5">
                <button type="button" onClick={() => void onDecide(approval.id, "APPROVE_ONCE")} className="rounded-lg border border-emerald-400/50 bg-emerald-500/15 px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-emerald-100">
                  approve once
                </button>
                <button type="button" onClick={() => void onDecide(approval.id, "APPROVE_SESSION")} className="rounded-lg border border-cyan-400/40 px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-cyan-100">
                  approve session
                </button>
                <button type="button" onClick={() => void onDecide(approval.id, "DENY")} className="rounded-lg border border-red-400/40 px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-red-200">
                  deny
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <h2 className="text-[11px] uppercase tracking-[0.2em] text-white/40">Decision history</h2>
        <div className="mt-1 max-h-[180px] space-y-1 overflow-y-auto pr-1">
          {history.map((approval) => (
            <div key={approval.id} className="rounded-lg border border-white/10 bg-black/20 px-2 py-1 text-[10.5px] text-white/60">
              <span className={approval.status.startsWith("APPROVED") ? "text-emerald-300" : approval.status === "DENIED" ? "text-red-300" : "text-white/40"}>{approval.status}</span> · {approval.toolId} · {approval.decidedAt ? new Date(approval.decidedAt).toLocaleString() : new Date(approval.createdAt).toLocaleString()}
              {approval.note ? ` · "${approval.note}"` : ""}
            </div>
          ))}
          {history.length === 0 && <p className="text-[10px] text-white/35">No decisions recorded yet.</p>}
        </div>
      </div>
    </div>
  );
}

type SettingsPayload = {
  config: Record<string, unknown>;
  resolved: Record<string, string>;
  providers: Record<string, unknown>;
  pythonSidecar: { available: boolean; python: string | null; pythonVersion: string | null; capabilities: string[]; restarts: number; lastError: string | null };
  envFile: boolean;
};

export function SettingsPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [allowlist, setAllowlist] = useState("");
  const [maxParallel, setMaxParallel] = useState(2);
  const [walkRealism, setWalkRealism] = useState(true);
  const [saving, setSaving] = useState(false);
  const [migrations, setMigrations] = useState<{ pending: string[]; records: { version: string; appliedAt: string | null }[] } | null>(null);

  const load = async () => {
    const [settingsRes, migrationsRes] = await Promise.all([fetch("/api/settings", { cache: "no-store" }), fetch("/api/system/migrate", { cache: "no-store" })]);
    if (settingsRes.ok) {
      const payload = (await settingsRes.json()) as SettingsPayload;
      setSettings(payload);
      const config = payload.config as { allowedCommands?: string[]; autonomy?: { maxConcurrentTasks?: number; walkRealism?: boolean } };
      setAllowlist((config.allowedCommands ?? []).join(", "));
      setMaxParallel(config.autonomy?.maxConcurrentTasks ?? 2);
      setWalkRealism(config.autonomy?.walkRealism ?? true);
    }
    if (migrationsRes.ok) setMigrations((await migrationsRes.json()) as { pending: string[]; records: { version: string; appliedAt: string | null }[] });
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          allowedCommands: allowlist
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
          autonomy: { maxConcurrentTasks: maxParallel, walkRealism },
        }),
      });
      const payload = (await res.json()) as { ok: boolean; error?: string };
      onNotice(payload.ok ? "Settings saved. Any change to the executable allowlist is written to the security audit log." : `Settings rejected: ${payload.error}`);
      await load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 text-[11px]">
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <h2 className="text-[11px] uppercase tracking-[0.2em] text-white/50">Settings &amp; security</h2>
        <label className="mt-2 block text-white/60">
          Executable allowlist for shell execution (comma separated, empty = deny-list only)
          <input
            value={allowlist}
            onChange={(event) => setAllowlist(event.target.value)}
            placeholder="e.g. git, node, npm, python"
            className="mt-1 w-full rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[11px] text-white outline-none focus:border-cyan-400/60"
          />
        </label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="text-white/60">
            Max concurrent light steps
            <input
              type="number"
              min={1}
              max={8}
              value={maxParallel}
              onChange={(event) => setMaxParallel(Number(event.target.value))}
              className="mt-1 w-full rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[11px] text-white"
            />
          </label>
          <label className="flex items-end gap-2 text-white/60">
            <input type="checkbox" checked={walkRealism} onChange={(event) => setWalkRealism(event.target.checked)} className="accent-cyan-400" />
            agents walk for the real backend duration
          </label>
        </div>
        <button type="button" onClick={() => void save()} disabled={saving} className="mt-2 rounded-lg border border-emerald-400/50 bg-emerald-500/15 px-3 py-1 text-[11px] text-emerald-100 disabled:opacity-40">
          {saving ? "saving…" : "save settings"}
        </button>
        <p className="mt-2 text-[10px] leading-snug text-white/40">
          Widening the allowlist is a deliberate, logged privilege decision: it appears in logs/security.log, the security_log table and the live event stream.
        </p>
      </div>

      {settings && (
        <>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <h3 className="text-[10px] uppercase tracking-[0.16em] text-white/40">Resolved paths (nothing is hardcoded)</h3>
            <ul className="mt-1 space-y-0.5 text-[10.5px] text-white/60">
              {Object.entries(settings.resolved).map(([key, value]) => (
                <li key={key}>
                  <span className="text-white/35">{key}:</span> <code className="text-cyan-200">{value}</code>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <h3 className="text-[10px] uppercase tracking-[0.16em] text-white/40">Providers &amp; credentials</h3>
            <ul className="mt-1 space-y-0.5 text-[10.5px] text-white/60">
              {Object.entries(settings.providers).map(([key, value]) => (
                <li key={key}>
                  <span className="text-white/35">{key}:</span> {String(value)}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[10px] text-white/35">
              Secrets live in the environment (.env present: {String(settings.envFile)}). They are never sent to prompts, logs, screenshots or the renderer; use the OS credential store for anything sensitive.
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <h3 className="text-[10px] uppercase tracking-[0.16em] text-white/40">Python capability sidecar</h3>
            <p className="mt-1 text-[10.5px] text-white/60">
              {settings.pythonSidecar.available ? "online" : "not running"} · python {settings.pythonSidecar.pythonVersion ?? "not found"} at {settings.pythonSidecar.python ?? "—"} · restarts {settings.pythonSidecar.restarts}
            </p>
            <p className="mt-1 text-[10.5px] text-white/50">capabilities: {settings.pythonSidecar.capabilities.join(", ") || "none detected"}</p>
            {settings.pythonSidecar.lastError && <p className="mt-1 text-[10px] text-amber-200">{settings.pythonSidecar.lastError}</p>}
            <p className="mt-1 text-[10px] text-white/35">pip install pywinauto pyautogui pytesseract pillow mss sounddevice faster-whisper — each is optional and reported honestly.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <h3 className="text-[10px] uppercase tracking-[0.16em] text-white/40">Schema migrations</h3>
            <p className="mt-1 text-[10.5px] text-white/60">
              {migrations ? `${migrations.records.length} applied · ${migrations.pending.length} pending` : "loading…"}
            </p>
            {migrations && migrations.pending.length > 0 && (
              <button
                type="button"
                onClick={async () => {
                  const res = await fetch("/api/system/migrate", { method: "POST" });
                  const payload = (await res.json()) as { applied?: unknown[]; failed?: unknown[] };
                  onNotice(`Migrations: ${payload.applied?.length ?? 0} applied, ${payload.failed?.length ?? 0} failed. Startup never runs schema changes automatically.`);
                  await load();
                }}
                className="mt-1.5 rounded-lg border border-amber-400/50 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-100"
              >
                apply {migrations.pending.length} pending migration(s) explicitly
              </button>
            )}
            <ul className="mt-1 space-y-0.5 text-[10px] text-white/45">
              {migrations?.records.map((record) => (
                <li key={record.version}>
                  <code className="text-cyan-200">{record.version}</code> {record.appliedAt ? new Date(record.appliedAt).toLocaleString() : ""}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
