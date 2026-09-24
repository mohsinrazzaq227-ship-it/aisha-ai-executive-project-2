"use client";

import { Card, Pill, usePolling } from "@/components/ui";

type AuditRow = { id: number; actor: string; action: string; target: string; risk: string; decision: string; detail: Record<string, unknown>; at: string };
type ApprovalRow = { id: string; taskId: string; action: string; target: string; risk: string; status: string; reason: string; actionHash: string; requestedAt: string; expiresAt: string; decidedAt: string | null; decidedBy: string | null; decisionNote: string | null };

export default function SecurityPage() {
  const audit = usePolling<{ audit: AuditRow[] }>("/api/system?section=audit", 6000);
  const approvals = usePolling<{ approvals: ApprovalRow[] }>("/api/approvals", 5000);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Security model" subtitle="enforced in code, not in the interface">
          <ul className="space-y-2 text-[11px] text-slate-300">
            <li>
              <span className="font-semibold text-slate-100">Command validation</span> — a hard deny-list blocks drive formatting, partitioning, registry tampering, persistence, credential extraction, security disabling, privilege escalation and destructive system commands. Optional allowlist widening is explicit and audited.
            </li>
            <li>
              <span className="font-semibold text-slate-100">Path confinement</span> — every path is resolved and checked against protected system roots and the AISHA workspace/sandbox boundary before any read, write or delete.
            </li>
            <li>
              <span className="font-semibold text-slate-100">Approval gate</span> — HIGH/CRITICAL tools refuse to execute without a granted approval whose action hash matches the exact current parameters. Tokens expire; mismatches are rejected and audited.
            </li>
            <li>
              <span className="font-semibold text-slate-100">Audit log</span> — every allowed or blocked decision is persisted with actor, target, risk and detail.
            </li>
          </ul>
        </Card>

        <Card title="Risk classes" subtitle="what requires a human decision">
          <ul className="space-y-2 text-[11px] text-slate-300">
            <li>
              <Pill value="LOW" /> research, reading files, hashing, internal calculations — execute directly.
            </li>
            <li>
              <Pill value="MEDIUM" /> file writes inside the workspace, browser navigation, document generation, media rendering — scoped and validated, no approval.
            </li>
            <li>
              <Pill value="HIGH" /> shell execution, file deletion, email sending, registry/network-sensitive operations — approval required, hash-bound.
            </li>
            <li>
              <Pill value="CRITICAL" /> destructive system operations, permission changes, credential handling — refused outright by the validator unless policy is widened deliberately.
            </li>
          </ul>
        </Card>

        <Card title="Honesty guarantees" subtitle="no silent degradation">
          <ul className="space-y-2 text-[11px] text-slate-300">
            <li>A tool that cannot run returns UNAVAILABLE with the probe reason and the fix command.</li>
            <li>A tool that returns SUCCESS with no evidence is downgraded to VERIFICATION_FAILED by the supervisor.</li>
            <li>Registered artifacts are re-read from disk and their hashes compared before a step can be reported successful.</li>
            <li>Deterministic renders are never labelled as AI generation.</li>
          </ul>
        </Card>
      </div>

      <Card title="Approval ledger" subtitle={`${approvals.data?.approvals.length ?? 0} approval record(s) — pending, granted, denied and expired are all kept`}>
        <div className="overflow-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="text-slate-500">
              <tr>
                <th className="p-2">status</th>
                <th className="p-2">risk</th>
                <th className="p-2">action</th>
                <th className="p-2">target</th>
                <th className="p-2">action hash</th>
                <th className="p-2">requested</th>
                <th className="p-2">decided by</th>
              </tr>
            </thead>
            <tbody>
              {(approvals.data?.approvals ?? []).slice(0, 60).map((row) => (
                <tr key={row.id} className="border-t border-white/5 text-slate-300">
                  <td className="p-2">
                    <Pill value={row.status} />
                  </td>
                  <td className="p-2">
                    <Pill value={row.risk} />
                  </td>
                  <td className="p-2">{row.action}</td>
                  <td className="p-2 max-w-[220px] truncate">{row.target}</td>
                  <td className="p-2 text-[10px]">{row.actionHash.slice(0, 16)}…</td>
                  <td className="p-2 text-[10px]">{new Date(row.requestedAt).toLocaleTimeString()}</td>
                  <td className="p-2 text-[10px]">{row.decidedBy ?? "—"}</td>
                </tr>
              ))}
              {!approvals.data?.approvals.length && (
                <tr>
                  <td className="p-2 text-slate-400" colSpan={7}>
                    No approvals yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Audit log" subtitle="every validator and approval decision">
        <ul className="max-h-[420px] space-y-1 overflow-auto text-[11px]">
          {(audit.data?.audit ?? []).map((row) => (
            <li key={row.id} className="flex gap-2">
              <span className="w-20 shrink-0 text-slate-500">{new Date(row.at).toLocaleTimeString()}</span>
              <span className={`w-20 shrink-0 font-semibold ${row.decision === "BLOCKED" || row.decision === "DENIED" ? "text-rose-300" : row.decision === "GRANTED" ? "text-emerald-300" : "text-sky-300"}`}>{row.decision}</span>
              <span className="w-32 shrink-0 truncate text-slate-400">{row.actor}</span>
              <span className="text-slate-300">{row.action}</span>
              <span className="truncate text-slate-500">{row.target}</span>
            </li>
          ))}
          {!audit.data?.audit.length && <li className="text-slate-400">No audit entries yet.</li>}
        </ul>
      </Card>
    </div>
  );
}
