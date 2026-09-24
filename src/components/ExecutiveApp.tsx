"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import ApprovalModal from "@/components/ApprovalModal";
import { ChatPanel } from "@/components/ChatPanel";
import { ActivityFeed, AgentInspector, AgentRoster, ApprovalsQueue, ArtifactsPanel, DoctorPanel, ProviderPanel, SettingsPanel, TaskPanel, UploadPanel } from "@/components/Panels";
import { useExecutive } from "@/components/useExecutive";

const Office3D = dynamic(() => import("@/components/office/Office3D"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center rounded-2xl border border-white/10 bg-[#05080f] text-[12px] text-white/40">
      Starting the 3D office renderer…
    </div>
  ),
});

export function ExecutiveApp() {
  const executive = useExecutive();
  const [attachedUploads, setAttachedUploads] = useState<string[]>([]);
  const [rightTab, setRightTab] = useState<"chat" | "tasks" | "artifacts" | "approvals" | "system" | "settings">("chat");
  const artifacts = executive.tasks.flatMap((task) => task.artifacts.map((artifact) => ({ ...artifact, taskTitle: task.title })));

  const connectionTone =
    executive.connection === "LIVE"
      ? "border-emerald-400/50 bg-emerald-500/10 text-emerald-200"
      : executive.connection === "CONNECTING"
        ? "border-cyan-400/40 bg-cyan-500/10 text-cyan-200"
        : "border-amber-400/50 bg-amber-500/10 text-amber-200";

  return (
    <div className="min-h-screen bg-[#040711] text-white">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#040711]/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1800px] items-center justify-between px-4 py-2.5">
          <div className="flex items-center gap-3">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-amber-300 to-cyan-400 text-[15px] text-slate-900">👑</div>
            <div>
              <h1 className="text-[13px] font-semibold uppercase tracking-[0.3em] text-white/90">AI-EXECUTIVE</h1>
              <p className="text-[10px] text-white/45">Local-first autonomous Windows agent operating system · free / offline-first</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[10px]">
            <span className={`rounded-md border px-2 py-1 uppercase tracking-[0.16em] ${connectionTone}`}>
              {executive.connection === "LIVE" ? "● system online" : executive.connection === "CONNECTING" ? "● connecting" : `● ${executive.connection.toLowerCase()}`}
            </span>
            <span className="rounded-md border border-white/15 px-2 py-1 text-white/60">master: {executive.agents.find((agent) => agent.id === "master_supervisor")?.state ?? "—"}</span>
            <span className="rounded-md border border-white/15 px-2 py-1 text-white/60">pending approvals: {executive.pendingApprovals.length}</span>
          </div>
        </div>
      </header>

      {executive.notice && (
        <div className="mx-auto max-w-[1800px] px-4 pt-2">
          <div className="flex items-start justify-between gap-3 rounded-xl border border-cyan-400/30 bg-cyan-500/5 px-3 py-2 text-[11.5px] text-cyan-100">
            <span className="whitespace-pre-wrap">{executive.notice.slice(0, 600)}</span>
            <button type="button" onClick={() => executive.setNotice(null)} className="text-white/50 hover:text-white">
              dismiss
            </button>
          </div>
        </div>
      )}

      <main className="mx-auto grid max-w-[1800px] gap-3 px-4 py-3 xl:grid-cols-[300px_minmax(0,1fr)_380px]">
        {/* Left column — team, uploads, quality */}
        <section className="space-y-3">
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3">
            <AgentRoster agents={executive.agents} selectedAgentId={executive.selectedAgentId} onSelect={executive.setSelectedAgentId} />
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3">
            <UploadPanel
              uploads={executive.uploads}
              limits={executive.uploadsLimits}
              onUpload={executive.uploadFiles}
              onRemove={executive.removeUpload}
              selected={attachedUploads}
              onToggleSelect={(id) => setAttachedUploads((previous) => (previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id]))}
            />
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3">
            <AgentInspector agent={executive.selectedAgent} quality={executive.quality} setQuality={executive.setQuality} />
          </div>
        </section>

        {/* Centre — the 3D office, then tasks */}
        <section className="space-y-3">
          <div className="relative h-[560px] overflow-hidden rounded-2xl border border-white/10 bg-[#05080f]">
            <Office3D agents={executive.agentRenderStates} quality={executive.quality} selectedAgentId={executive.selectedAgentId} onSelectAgent={executive.setSelectedAgentId} />
            <div className="pointer-events-none absolute left-3 top-3 rounded-lg border border-white/10 bg-black/50 px-2 py-1 text-[10px] text-white/60">
              Live 3D office · agent states and walking paths come from the backend event stream
            </div>
            <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-1 text-[9.5px]">
              {executive.agentRenderStates.map((agent) => (
                <span
                  key={agent.id}
                  className="rounded border px-1.5 py-0.5"
                  style={{
                    borderColor: `${agent.color}66`,
                    color: agent.color,
                    background: `${agent.color}14`,
                  }}
                >
                  {agent.glyph} {agent.name.split(" ")[0]} · {agent.state.replace(/_/g, " ").toLowerCase()}
                  {agent.carrying ? " · carrying payload" : ""}
                </span>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3">
            <TaskPanel tasks={executive.tasks} onControl={executive.controlTask} />
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3">
            <ActivityFeed events={executive.events} />
          </div>
        </section>

        {/* Right column — chat / approvals / system */}
        <section className="flex min-h-[560px] flex-col gap-3">
          <div className="flex gap-1 rounded-xl border border-white/10 bg-white/[0.02] p-1 text-[11px]">
            {(["chat", "tasks", "artifacts", "approvals", "system", "settings"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setRightTab(tab)}
                className={`flex-1 rounded-lg px-2 py-1 uppercase tracking-[0.14em] ${rightTab === tab ? "bg-cyan-500/15 text-cyan-100" : "text-white/50 hover:bg-white/5"}`}
              >
                {tab}
              </button>
            ))}
          </div>

          {rightTab === "chat" && (
            <div className="flex-1 rounded-2xl border border-white/10 bg-white/[0.02] p-3">
              <ChatPanel
                onSend={executive.sendMessage}
                busy={executive.busy}
                events={executive.events}
                speak={executive.speak}
                stopSpeaking={executive.stopSpeaking}
                attachedUploads={attachedUploads}
                onNotice={executive.setNotice}
              />
            </div>
          )}

          {rightTab === "tasks" && (
            <div className="flex-1 space-y-3 rounded-2xl border border-white/10 bg-white/[0.02] p-3">
              <TaskPanel tasks={executive.tasks} onControl={executive.controlTask} />
            </div>
          )}

          {rightTab === "artifacts" && (
            <div className="flex-1 space-y-3 overflow-y-auto rounded-2xl border border-white/10 bg-white/[0.02] p-3">
              <ArtifactsPanel artifacts={artifacts} tasks={executive.tasks} />
            </div>
          )}

          {rightTab === "approvals" && (
            <div className="flex-1 space-y-3 overflow-y-auto rounded-2xl border border-white/10 bg-white/[0.02] p-3">
              <ApprovalsQueue approvals={executive.approvals} onDecide={executive.decideApproval} />
            </div>
          )}

          {rightTab === "settings" && (
            <div className="flex-1 space-y-3 overflow-y-auto rounded-2xl border border-white/10 bg-white/[0.02] p-3">
              <SettingsPanel onNotice={executive.setNotice} />
            </div>
          )}

          {rightTab === "system" && (
            <div className="flex-1 space-y-3 overflow-y-auto rounded-2xl border border-white/10 bg-white/[0.02] p-3">
              <DoctorPanel doctor={executive.doctor} onRun={executive.runDoctor} running={executive.doctorRunning} />
              <ProviderPanel providers={executive.providers} />
              <div className="rounded-xl border border-white/10 bg-black/20 p-2.5 text-[10.5px] leading-relaxed text-white/55">
                <p className="mb-1 uppercase tracking-[0.16em] text-white/40">How this works</p>
                Nothing in this interface is animated theatre: the Master Supervisor plans in the backend, the approval layer verifies the exact parameters it was given, tools perform real work
                (network research, document extraction, filesystem writes, FFmpeg renders, shell execution), and both the task panel and the 3D office subscribe to the same event stream.
                Providers shown as DISABLED or UNAVAILABLE are genuinely missing in this environment — they are never silently replaced by a paid service.
              </div>
            </div>
          )}
        </section>
      </main>

      <ApprovalModal approvals={executive.pendingApprovals} onDecide={executive.decideApproval} />
    </div>
  );
}

export default ExecutiveApp;
