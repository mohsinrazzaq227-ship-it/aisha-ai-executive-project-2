"use client";

import { useState } from "react";
import { Card, Pill, apiPost, usePolling } from "@/components/ui";

type Check = { id: string; area: string; name: string; status: string; detail: string; ms: number };
type Run = { id: string; suite: string; passed: number; failed: number; total: number; ms: number; at: string; results: Check[] };

export default function VerificationPage() {
  const history = usePolling<{ runs: Run[]; latest: Run | null }>("/api/tests", 10000);
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<Run | null>(null);

  const run = live ?? history.data?.latest ?? null;
  const areas = run ? [...new Set(run.results.map((check) => check.area))] : [];

  async function execute() {
    setRunning(true);
    const response = await apiPost<Run>("/api/tests", { confirm: "run-acceptance-suite" });
    setLive(response.data);
    setRunning(false);
    await history.refresh();
  }

  return (
    <div className="space-y-4">
      <Card
        title="Verification report"
        subtitle={run ? `${run.passed} PASS · ${run.failed} FAIL · ${run.total} checks · ${run.suite} · ${new Date(run.at).toLocaleString()}` : "no suite has run in this database yet"}
        actions={
          <button type="button" onClick={() => void execute()} disabled={running} className="rounded-lg border border-amber-400/40 bg-amber-400/15 px-3 py-1.5 text-xs font-semibold text-amber-200 disabled:opacity-50">
            {running ? "executing real checks…" : "Run acceptance suite"}
          </button>
        }
      >
        <p className="text-[11px] text-slate-400">
          The suite executes real tools, real subprocesses and real database writes. UNAVAILABLE means the capability was probed and honestly reported as not present on this
          host — it is not counted as a pass and it is not hidden.
        </p>
      </Card>

      {run && (
        <>
          <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-4">
            {areas.map((area) => {
              const checks = run.results.filter((check) => check.area === area);
              const passed = checks.filter((check) => check.status === "PASS").length;
              const failed = checks.filter((check) => check.status === "FAIL").length;
              const unavailable = checks.filter((check) => check.status === "UNAVAILABLE").length;
              return (
                <div key={area} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">{area}</span>
                    <Pill value={failed ? "FAILED" : unavailable ? "UNAVAILABLE" : "PASS"} />
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">
                    {passed} pass · {failed} fail · {unavailable} unavailable
                  </p>
                </div>
              );
            })}
          </div>

          <Card title="Checks" subtitle="status, duration and the raw reason">
            <ul className="max-h-[520px] space-y-1 overflow-auto text-[11px]">
              {run.results.map((check) => (
                <li key={check.id} className="flex flex-wrap gap-2 border-b border-white/5 pb-1">
                  <span className="w-24 shrink-0 text-slate-500">{check.area}</span>
                  <span className={`w-24 shrink-0 font-semibold ${check.status === "PASS" ? "text-emerald-300" : check.status === "FAIL" ? "text-rose-300" : "text-amber-300"}`}>{check.status}</span>
                  <span className="w-56 shrink-0 text-slate-200">{check.name}</span>
                  <span className="flex-1 text-slate-400">{check.detail}</span>
                  <span className="w-14 shrink-0 text-right text-slate-500">{check.ms}ms</span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}

      <Card title="Suite history" subtitle="kept in the database as evidence over time">
        <ul className="space-y-1 text-[11px]">
          {(history.data?.runs ?? []).map((entry) => (
            <li key={entry.id} className="flex gap-3 text-slate-400">
              <span className="w-40 shrink-0">{new Date(entry.at).toLocaleString()}</span>
              <span className="w-24 text-emerald-300">{entry.passed} pass</span>
              <span className="w-24 text-rose-300">{entry.failed} fail</span>
              <span className="w-24">{entry.total} checks</span>
              <span>{Math.round(entry.ms / 100) / 10}s</span>
            </li>
          ))}
          {!history.data?.runs.length && <li className="text-slate-400">No runs recorded yet.</li>}
        </ul>
      </Card>
    </div>
  );
}
