"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { QualityMode } from "@/components/office/Office3D";
import type { AgentRenderState } from "@/components/office/Office3D";

export type TaskStep = {
  id: string;
  index: number;
  title: string;
  detail: string | null;
  agentId: string;
  agentName: string;
  toolId: string | null;
  risk: "LOW" | "MEDIUM" | "HIGH";
  requiresApproval: boolean;
  status: string;
  approvalId: string | null;
  summary: string | null;
  error: string | null;
};

export type TaskArtifact = {
  id: string;
  taskId?: string;
  kind: string;
  name: string;
  relPath: string;
  mime: string;
  size: number;
  validated: boolean;
  createdAt: string;
  downloadUrl?: string;
};

export type TaskRecord = {
  id: string;
  runId: string;
  title: string;
  intent: string;
  status: string;
  progress: number;
  plannerEngine: string;
  currentAgentId: string | null;
  currentAgent: { name: string; role: string; glyph: string } | null;
  summary: string | null;
  finalAnswer: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  workDir: string;
  request: { message: string; uploadIds?: string[] };
  steps: TaskStep[];
  artifacts: TaskArtifact[];
  approvals: ApprovalRecord[];
};

export type ApprovalRecord = {
  id: string;
  taskId: string;
  stepId: string;
  agentId: string;
  agent: { name: string; role: string; glyph: string; color: string; callsign: string };
  toolId: string;
  toolLabel: string;
  approvalLabel: string;
  risk: "LOW" | "MEDIUM" | "HIGH";
  action: Record<string, unknown>;
  parameters: { name: string; type: string; required: boolean; description: string }[];
  parametersHash: string;
  reason: string;
  target: string | null;
  status: string;
  decision: string | null;
  scope: string | null;
  note: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  expired: boolean;
};

export type AgentRecord = {
  id: string;
  name: string;
  callsign: string;
  role: string;
  glyph: string;
  color: string;
  accent: string;
  station: string;
  stationLabel: string;
  slot: number;
  brief: string;
  capabilities: string[];
  tools: string[];
  riskProfile: string;
  state: string;
  mood: string;
  taskId: string | null;
  lastMessage: string | null;
  updatedAt: string | null;
};

export type ProviderRecord = {
  id: string;
  label: string;
  kind: string;
  status: string;
  detail: string;
  local: boolean;
  cost: string;
  requiresConfig?: string[];
};

export type LiveEvent = {
  id?: number;
  ts: string;
  taskId?: string | null;
  agentId?: string | null;
  type: string;
  message: string;
  data?: Record<string, unknown>;
  severity?: string;
};

export type UploadRecord = {
  id: string;
  taskId: string | null;
  originalName: string;
  safeName: string;
  mime: string;
  size: number;
  sizeHuman: string;
  status: string;
  sha256: string;
  createdAt: string;
  exists: boolean;
  extraction?: Record<string, unknown> | null;
};

export type DoctorReport = {
  generatedAt: string;
  host: { platform: string; release: string; arch: string; cpus: number; totalMemory: string; hostname: string };
  summary: { pass: number; warning: number; fail: number; notApplicable: number; clientSide: number; notConfigured: number };
  checks: { id: string; group: string; name: string; status: string; detail: string; action?: string }[];
  durationMs: number;
};

export type ConnectionState = "CONNECTING" | "LIVE" | "RECONNECTING" | "OFFLINE";

export function useExecutive() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [uploadsLimits, setUploadsLimits] = useState<{ maxBytes: number; allowedExtensions: string[] } | null>(null);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("CONNECTING");
  const [quality, setQuality] = useState<QualityMode>("BALANCED");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>("master_supervisor");
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const walkStateRef = useRef<Record<string, { path: [number, number][]; walkMs: number; walkStartedAt: number; carrying: { kind: string; name: string } | null }>>({});
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshAll = useCallback(async () => {
    try {
      const [tasksRes, approvalsRes, systemRes, uploadsRes] = await Promise.all([
        fetch("/api/tasks", { cache: "no-store" }),
        fetch("/api/approvals", { cache: "no-store" }),
        fetch("/api/system", { cache: "no-store" }),
        fetch("/api/uploads", { cache: "no-store" }),
      ]);
      if (tasksRes.ok) setTasks(((await tasksRes.json()) as { tasks: TaskRecord[] }).tasks);
      if (approvalsRes.ok) setApprovals(((await approvalsRes.json()) as { approvals: ApprovalRecord[] }).approvals);
      if (systemRes.ok) {
        const payload = (await systemRes.json()) as { agents: AgentRecord[]; providers: ProviderRecord[] };
        setAgents(payload.agents);
        setProviders(payload.providers);
      }
      if (uploadsRes.ok) {
        const payload = (await uploadsRes.json()) as { uploads: UploadRecord[]; limits: { maxBytes: number; allowedExtensions: string[] } };
        setUploads(payload.uploads);
        setUploadsLimits(payload.limits);
      }
    } catch {
      setConnection("RECONNECTING");
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void refreshAll(), 900);
  }, [refreshAll]);

  useEffect(() => {
    void refreshAll();
    const interval = setInterval(() => void refreshAll(), 8000);
    return () => clearInterval(interval);
  }, [refreshAll]);

  // Authoritative live stream: the 3D office and every panel read from here.
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("ready", () => setConnection("LIVE"));
    source.addEventListener("executive", (raw) => {
      try {
        const event = JSON.parse((raw as MessageEvent).data) as LiveEvent;
        setConnection("LIVE");
        setEvents((prev) => [...prev.slice(-400), event]);
        if (event.agentId) {
          if (event.type === "AGENT_WALKING") {
            const data = (event.data ?? {}) as { path?: [number, number][]; walkMs?: number; carrying?: { kind: string; name: string } | null };
            walkStateRef.current[event.agentId] = {
              path: data.path ?? [],
              walkMs: data.walkMs ?? 1200,
              walkStartedAt: Date.now(),
              carrying: data.carrying ?? walkStateRef.current[event.agentId]?.carrying ?? null,
            };
          }
          if (event.type === "AGENT_STATE" && (event.data as { state?: string })?.state === "CARRYING") {
            const payload = (event.data as { payload?: { kind: string; name: string } }).payload;
            walkStateRef.current[event.agentId] = { ...(walkStateRef.current[event.agentId] ?? { path: [], walkMs: 0, walkStartedAt: Date.now(), carrying: null }), carrying: payload ?? null };
          }
          setAgents((prev) =>
            prev.map((agent) =>
              agent.id === event.agentId
                ? {
                    ...agent,
                    state: (event.data as { state?: string })?.state && event.type === "AGENT_STATE" ? String((event.data as { state?: string }).state) : stateFromEvent(event.type, agent.state),
                    lastMessage: event.message.slice(0, 400),
                    taskId: event.taskId ?? agent.taskId,
                    updatedAt: event.ts,
                  }
                : agent,
            ),
          );
          if (["AGENT_HANDOFF", "AGENT_RECEIVING", "TOOL_COMPLETED", "TASK_STATUS", "ARTIFACT_CREATED"].includes(event.type)) {
            if (event.type !== "AGENT_STATE") walkStateRef.current[event.agentId] = { ...(walkStateRef.current[event.agentId] ?? { path: [], walkMs: 0, walkStartedAt: 0, carrying: null }) };
          }
          if (event.type === "AGENT_STATE" && (event.data as { state?: string })?.state !== "CARRYING") {
            walkStateRef.current[event.agentId] = { ...(walkStateRef.current[event.agentId] ?? { path: [], walkMs: 0, walkStartedAt: 0, carrying: null }), carrying: null };
          }
        }
        if (
          ["TASK_CREATED", "TASK_PLANNED", "TASK_STATUS", "APPROVAL_REQUESTED", "APPROVAL_GRANTED", "APPROVAL_DENIED", "APPROVAL_INVALIDATED", "TOOL_COMPLETED", "TOOL_FAILED", "ARTIFACT_CREATED", "VIDEO_VALIDATED", "SUPERVISOR_MESSAGE"].includes(
            event.type,
          )
        ) {
          scheduleRefresh();
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    source.onerror = () => setConnection((prev) => (prev === "LIVE" ? "RECONNECTING" : "OFFLINE"));
    return () => source.close();
  }, [scheduleRefresh]);

  const agentRenderStates: AgentRenderState[] = useMemo(
    () =>
      agents.map((agent) => {
        const walk = walkStateRef.current[agent.id];
        return {
          id: agent.id,
          name: agent.name,
          role: agent.role,
          glyph: agent.glyph,
          color: agent.color,
          accent: agent.accent,
          station: agent.station as AgentRenderState["station"],
          stationLabel: agent.stationLabel,
          slot: agent.slot,
          state: agent.state,
          mood: agent.mood,
          lastMessage: agent.lastMessage,
          path: walk?.path ?? [],
          walkMs: walk?.walkMs ?? 0,
          walkStartedAt: walk?.walkStartedAt ?? 0,
          carrying: walk?.carrying ?? null,
          taskId: agent.taskId,
        };
      }),
    [agents],
  );

  const pendingApprovals = useMemo(() => approvals.filter((approval) => approval.status === "PENDING" && !approval.expired), [approvals]);

  const sendMessage = useCallback(
    async (message: string, uploadIds: string[] = []) => {
      setBusy(true);
      try {
        const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, uploadIds }) });
        const payload = (await res.json()) as { ok: boolean; error?: string; planner?: { engine: string; detail: string }; title?: string };
        if (!payload.ok) setNotice(payload.error ?? "The supervisor rejected the request.");
        else setNotice(`Plan accepted: ${payload.title} · planner: ${payload.planner?.engine ?? "unknown"}`);
        scheduleRefresh();
        return payload.ok;
      } catch (error) {
        setNotice(`Could not reach the supervisor: ${(error as Error).message}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [scheduleRefresh],
  );

  const decideApproval = useCallback(
    async (approvalId: string, decision: "APPROVE_ONCE" | "APPROVE_SESSION" | "DENY" | "MODIFY", options: { note?: string; parameters?: Record<string, unknown> } = {}) => {
      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalId, decision, note: options.note, parameters: options.parameters }),
      });
      const payload = (await res.json()) as { ok: boolean; message: string };
      setNotice(payload.message);
      scheduleRefresh();
      return payload.ok;
    },
    [scheduleRefresh],
  );

  const controlTask = useCallback(
    async (taskId: string, action: "pause" | "resume" | "cancel" | "retry") => {
      const res = await fetch("/api/tasks", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId, action }) });
      const payload = (await res.json()) as { ok: boolean; message: string };
      setNotice(payload.message);
      scheduleRefresh();
    },
    [scheduleRefresh],
  );

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const form = new FormData();
      for (const file of Array.from(files)) form.append("file", file);
      setBusy(true);
      try {
        const res = await fetch("/api/uploads", { method: "POST", body: form });
        const payload = (await res.json()) as { ok: boolean; stored?: { safeName: string }[]; rejected?: { name: string; reason: string }[] };
        if (payload.rejected && payload.rejected.length > 0) setNotice(`Rejected: ${payload.rejected.map((r) => `${r.name} (${r.reason})`).join("; ")}`);
        else setNotice(`${payload.stored?.length ?? 0} file(s) confirmed by the backend.`);
        scheduleRefresh();
        return payload;
      } catch (error) {
        setNotice(`Upload failed: ${(error as Error).message}`);
        return { ok: false };
      } finally {
        setBusy(false);
      }
    },
    [scheduleRefresh],
  );

  const removeUpload = useCallback(
    async (id: string) => {
      await fetch(`/api/uploads?id=${id}`, { method: "DELETE" });
      scheduleRefresh();
    },
    [scheduleRefresh],
  );

  const runDoctor = useCallback(async () => {
    setDoctorRunning(true);
    try {
      const res = await fetch("/api/system?doctor=1", { cache: "no-store" });
      const payload = (await res.json()) as { doctor: DoctorReport };
      setDoctor(payload.doctor);
    } catch (error) {
      setNotice(`Doctor failed: ${(error as Error).message}`);
    } finally {
      setDoctorRunning(false);
    }
  }, []);

  const speak = useCallback((text: string, options: { rate?: number; pitch?: number } = {}) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return false;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = options.rate ?? 1;
    utterance.pitch = options.pitch ?? 1;
    const preferred = window.speechSynthesis.getVoices().find((voice) => /samantha|aria|jenny|female|zira|karen/i.test(voice.name));
    if (preferred) utterance.voice = preferred;
    window.speechSynthesis.speak(utterance);
    return true;
  }, []);

  const stopSpeaking = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);

  return {
    tasks,
    approvals,
    pendingApprovals,
    agents,
    agentRenderStates,
    providers,
    uploads,
    uploadsLimits,
    events,
    connection,
    quality,
    setQuality,
    selectedAgentId,
    setSelectedAgentId,
    doctor,
    doctorRunning,
    runDoctor,
    busy,
    notice,
    setNotice,
    refreshAll,
    sendMessage,
    decideApproval,
    controlTask,
    uploadFiles,
    removeUpload,
    speak,
    stopSpeaking,
    selectedAgent: agents.find((agent) => agent.id === selectedAgentId) ?? null,
  };
}

function stateFromEvent(type: string, previous: string): string {
  switch (type) {
    case "AGENT_WALKING":
      return "WALKING";
    case "AGENT_WORKING":
      return "WORKING";
    case "AGENT_SPEAKING":
      return "SPEAKING";
    case "AGENT_HANDOFF":
      return "HANDOFF";
    case "AGENT_RECEIVING":
      return "RECEIVING";
    case "AGENT_COMPLETED":
      return "COMPLETED";
    case "AGENT_ERROR":
      return "ERROR";
    default:
      return previous;
  }
}
