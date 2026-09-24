"use client";

import { useEffect, useMemo, useState } from "react";
import type { ApprovalRecord } from "@/components/useExecutive";

const RISK_STYLE: Record<string, string> = {
  LOW: "border-emerald-400/40 bg-emerald-500/10 text-emerald-200",
  MEDIUM: "border-amber-400/40 bg-amber-500/10 text-amber-200",
  HIGH: "border-red-400/50 bg-red-500/15 text-red-200",
};

function secondsLeft(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

export function ApprovalModal({
  approvals,
  onDecide,
}: {
  approvals: ApprovalRecord[];
  onDecide: (approvalId: string, decision: "APPROVE_ONCE" | "APPROVE_SESSION" | "DENY" | "MODIFY", options?: { note?: string; parameters?: Record<string, unknown> }) => Promise<boolean>;
}) {
  const [note, setNote] = useState("");
  const [modifyMode, setModifyMode] = useState(false);
  const [modified, setModified] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const approval = approvals[0] ?? null;

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setModifyMode(false);
    setNote("");
    setError(null);
    setModified(approval ? JSON.stringify(approval.action, null, 2) : "");
  }, [approval?.id, approval]);

  const prettyAction = useMemo(() => {
    if (!approval) return "";
    const entries = Object.entries(approval.action ?? {});
    if (entries.length === 0) return "(no parameters)";
    return entries
      .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join("\n");
  }, [approval]);

  if (!approval) return null;

  const remaining = secondsLeft(approval.expiresAt);
  const isCommand = typeof approval.action.command === "string";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-amber-400/30 bg-[#0b1220] shadow-2xl shadow-amber-500/10">
        <div className="flex items-center justify-between border-b border-white/10 bg-amber-500/10 px-5 py-3">
          <div className="flex items-center gap-3">
            <span className="text-lg">🛡️</span>
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-amber-200">Approval required</p>
              <p className="text-[11px] text-amber-100/70">The supervisor has stopped and will not continue without your decision.</p>
            </div>
          </div>
          <div className="text-right">
            <span className={`rounded-lg border px-2 py-1 text-xs font-semibold ${RISK_STYLE[approval.risk]}`}>RISK {approval.risk}</span>
            <p className="mt-1 text-[10px] text-white/50">{remaining}s until this request expires</p>
          </div>
        </div>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4 text-sm">
          <div className="grid grid-cols-2 gap-3 text-[12px]">
            <Field label="Agent">{approval.agent.glyph} {approval.agent.name} · {approval.agent.role}</Field>
            <Field label="Action">{approval.approvalLabel}</Field>
            <Field label="Tool id"><code className="text-cyan-200">{approval.toolId}</code></Field>
            <Field label="Target">{approval.target ?? "n/a"}</Field>
          </div>

          <div>
            <p className="mb-1 text-[11px] uppercase tracking-[0.16em] text-white/50">{isCommand ? "Exact command that will run" : "Exact parameters that will be used"}</p>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-xl border border-white/10 bg-black/50 p-3 text-[12px] leading-relaxed text-cyan-100">{prettyAction}</pre>
            <p className="mt-1 text-[10px] text-white/40">
              Parameter hash <code>{approval.parametersHash.slice(0, 32)}…</code> — verified again at execution time. If anything changes, this approval is void and you will be asked again.
            </p>
          </div>

          <Field label="Reason">{approval.reason}</Field>

          {approval.parameters.length > 0 && (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <p className="mb-2 text-[11px] uppercase tracking-[0.16em] text-white/50">Tool schema (parameters the tool accepts)</p>
              <ul className="space-y-1 text-[11px] text-white/70">
                {approval.parameters.map((param) => (
                  <li key={param.name}>
                    <code className="text-cyan-200">{param.name}</code>
                    <span className="text-white/40"> ({param.type}{param.required ? ", required" : ""})</span> — {param.description}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {modifyMode && (
            <div>
              <p className="mb-1 text-[11px] uppercase tracking-[0.16em] text-white/50">Edit parameters (JSON). The task will then request approval again for your edited action.</p>
              <textarea
                value={modified}
                onChange={(event) => setModified(event.target.value)}
                rows={6}
                className="w-full rounded-xl border border-white/15 bg-black/50 p-3 font-mono text-[12px] text-cyan-100 outline-none focus:border-cyan-400/60"
              />
            </div>
          )}

          <div>
            <p className="mb-1 text-[11px] uppercase tracking-[0.16em] text-white/50">Note (stored in the audit log)</p>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Why you decided this"
              className="w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-[12px] text-white outline-none focus:border-cyan-400/60"
            />
          </div>

          {error && <p className="rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{error}</p>}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/10 bg-black/30 px-5 py-3">
          <button
            type="button"
            onClick={async () => {
              const ok = await onDecide(approval.id, "DENY", { note });
              if (!ok) setError("Could not record the decision. The request may already be decided or expired.");
            }}
            className="rounded-xl border border-red-400/40 bg-red-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-red-200 transition hover:bg-red-500/20"
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => setModifyMode((value) => !value)}
            className="rounded-xl border border-white/20 bg-white/5 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-white/80 transition hover:bg-white/10"
          >
            {modifyMode ? "Cancel edit" : "Modify"}
          </button>
          <button
            type="button"
            onClick={async () => {
              const ok = await onDecide(approval.id, "APPROVE_SESSION", { note });
              if (!ok) setError("Could not record the decision.");
            }}
            className="rounded-xl border border-cyan-400/40 bg-cyan-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-cyan-100 transition hover:bg-cyan-500/20"
          >
            Approve for session
          </button>
          <button
            type="button"
            onClick={async () => {
              if (modifyMode) {
                try {
                  const parsed = JSON.parse(modified) as Record<string, unknown>;
                  const ok = await onDecide(approval.id, "MODIFY", { note, parameters: parsed });
                  if (!ok) setError("MODIFY was rejected — check that the parameters are a JSON object.");
                } catch (parseError) {
                  setError(`Parameters must be valid JSON: ${(parseError as Error).message}`);
                }
                return;
              }
              const ok = await onDecide(approval.id, "APPROVE_ONCE", { note });
              if (!ok) setError("Could not record the decision.");
            }}
            className="rounded-xl border border-emerald-400/50 bg-emerald-500/20 px-5 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-emerald-100 transition hover:bg-emerald-500/30"
          >
            {modifyMode ? "Apply new parameters" : "Approve once"}
          </button>
        </div>
        <p className="border-t border-white/5 px-5 py-2 text-[10px] text-white/35" key={tick}>
          Nothing is executed until you decide. The execution layer re-verifies this exact action and its hash before running, and every decision is written to the audit log.
        </p>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.16em] text-white/40">{label}</p>
      <p className="text-[12px] text-white/85">{children}</p>
    </div>
  );
}

export default ApprovalModal;
