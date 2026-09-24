"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Json = Record<string, unknown>;

export async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok && response.status !== 404 && response.status !== 501) {
    throw new Error(`${url} → HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function apiPost<T>(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as T;
  return { ok: response.ok, status: response.status, data };
}

export function usePolling<T>(url: string, intervalMs: number, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await apiGet<T>(url);
      setData(next);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs, refresh]);

  return { data, error, loading, refresh };
}

/** Live event stream via SSE with the persisted event table as the only source. */
export function useEventStream(limit = 120) {
  const [rows, setRows] = useState<Json[]>([]);
  const ready = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    apiGet<{ events: Json[] }>(`/api/events?limit=${limit}`)
      .then((initial) => {
        if (!cancelled) setRows(initial.events);
      })
      .catch(() => undefined)
      .finally(() => {
        if (cancelled) return;
        source = new EventSource(`/api/events?stream=1`);
        source.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data) as { type: string; events?: Json[] };
            if (payload.type === "events" && payload.events?.length) {
              setRows((current) => [...payload.events!, ...current].slice(0, 400));
            }
          } catch {
            /* ignore malformed frame */
          }
        };
        ready.current = true;
      });
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [limit]);

  return rows;
}

const TONES: Record<string, string> = {
  SUCCESS: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  RUNNING: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  PENDING: "bg-slate-500/15 text-slate-300 border-slate-500/40",
  PLANNING: "bg-indigo-500/15 text-indigo-300 border-indigo-500/40",
  WAITING_DEPENDENCY: "bg-amber-500/10 text-amber-200 border-amber-500/30",
  WAITING_APPROVAL: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  PARTIAL: "bg-amber-500/15 text-amber-200 border-amber-500/40",
  FAILED: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  BLOCKED: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  TIMEOUT: "bg-orange-500/15 text-orange-300 border-orange-500/40",
  CANCELLED: "bg-slate-500/15 text-slate-300 border-slate-500/40",
  UNAVAILABLE: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/40",
  VERIFICATION_FAILED: "bg-red-500/20 text-red-200 border-red-500/50",
  HIGH: "bg-amber-500/15 text-amber-200 border-amber-500/40",
  CRITICAL: "bg-rose-500/20 text-rose-200 border-rose-500/50",
  MEDIUM: "bg-sky-500/10 text-sky-200 border-sky-500/30",
  LOW: "bg-slate-500/10 text-slate-300 border-slate-500/30",
  PASS: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  AVAILABLE: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  AVAILABLE_BUT_OPTIONAL: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  MISCONFIGURED: "bg-amber-500/15 text-amber-200 border-amber-500/40",
  MISSING: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  DISABLED: "bg-slate-500/15 text-slate-300 border-slate-500/40",
};

export function Pill({ value, title }: { value: string; title?: string }) {
  const tone = TONES[value] ?? "bg-white/5 text-slate-300 border-white/10";
  return (
    <span title={title} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}>
      {value.replace(/_/g, " ")}
    </span>
  );
}

export function Card({ title, subtitle, children, actions, className = "" }: { title?: string; subtitle?: string; children: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/10 bg-white/[0.03] p-4 shadow-lg shadow-black/20 backdrop-blur ${className}`}>
      {(title || actions) && (
        <header className="mb-3 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-sm font-semibold tracking-wide text-slate-100">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function StatusDot({ state }: { state: string }) {
  const color =
    state === "RUNNING" || state === "WORKING"
      ? "bg-sky-400"
      : state === "SUCCESS"
        ? "bg-emerald-400"
        : state === "FAILED" || state === "BLOCKED"
          ? "bg-rose-400"
          : state === "WAITING_APPROVAL" || state === "REQUESTING_APPROVAL"
            ? "bg-amber-400"
            : "bg-slate-500";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}
