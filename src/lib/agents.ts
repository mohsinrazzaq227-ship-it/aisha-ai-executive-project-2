/**
 * Agent registry — the preserved Project 1 product concept, made coherent.
 *
 * ONE registry. It is seeded into the database, drives the office layout, and is
 * the only place that maps a role to a station, a colour and a risk ceiling.
 * Agents never bypass approval: `riskProfile` is the highest risk an agent may
 * *request*, not a permission to execute.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agentStates, agents, type AgentPosition, type AgentState, type RiskLevel } from "@/db/schema";
import { emit } from "@/lib/events";

export type Station = { id: string; label: string; x: number; z: number; kind: "desk" | "station" | "gate" | "stage" };

export const STATIONS: Record<string, Station> = {
  MASTER_SEAT: { id: "MASTER_SEAT", label: "Executive Seat", x: 0, z: -7, kind: "desk" },
  RESEARCH_DESK: { id: "RESEARCH_DESK", label: "Research Desk", x: -9, z: -2, kind: "desk" },
  BROWSER_STATION: { id: "BROWSER_STATION", label: "Browser Station", x: -9, z: 3, kind: "station" },
  COMPUTER_DESK: { id: "COMPUTER_DESK", label: "Computer Console", x: -3, z: 6, kind: "station" },
  FILE_VAULT: { id: "FILE_VAULT", label: "File Vault", x: 4, z: 6, kind: "station" },
  DOC_STUDIO: { id: "DOC_STUDIO", label: "Document Studio", x: 9, z: 3, kind: "desk" },
  COMMS_BAY: { id: "COMMS_BAY", label: "Comms Bay", x: 9, z: -2, kind: "station" },
  DEV_LAB: { id: "DEV_LAB", label: "Engineering Lab", x: -13, z: -7, kind: "desk" },
  DATA_LAB: { id: "DATA_LAB", label: "Data Lab", x: 13, z: -7, kind: "desk" },
  MEDIA_STUDIO: { id: "MEDIA_STUDIO", label: "Media Studio", x: 0, z: 2, kind: "stage" },
  QA_LAB: { id: "QA_LAB", label: "QA Lab", x: -4, z: -3, kind: "desk" },
  SECURITY_GATE: { id: "SECURITY_GATE", label: "Security Gate", x: 4, z: -3, kind: "gate" },
};

export type AgentDefinition = {
  id: string;
  name: string;
  callsign: string;
  role: string;
  tier: "SUPERVISOR" | "SPECIALIST" | "SUPPORT";
  station: string;
  color: string;
  accent: string;
  glyph: string;
  personality: string;
  capabilities: string[];
  tools: string[];
  riskProfile: RiskLevel;
  voice: { rate: number; pitch: number };
  brief: string;
};

export const AGENTS: AgentDefinition[] = [
  {
    id: "aisha",
    name: "AISHA",
    callsign: "MASTER_SUPERVISOR",
    role: "Master Supervisor",
    tier: "SUPERVISOR",
    station: "MASTER_SEAT",
    color: "#f6c045",
    accent: "#fff3cf",
    glyph: "👑",
    personality: "Decisive, evidence-driven, never claims success without verification.",
    capabilities: ["intent understanding", "risk classification", "task-graph planning", "delegation", "verification", "reporting"],
    tools: ["system.shell", "report.write", "email.send"],
    riskProfile: "CRITICAL",
    voice: { rate: 1.0, pitch: 1.02 },
    brief: "Single point of authority: plans, delegates, gates risk, verifies results and reports evidence.",
  },
  {
    id: "research",
    name: "Nova Reyes",
    callsign: "RESEARCH_AGENT",
    role: "Research Agent",
    tier: "SPECIALIST",
    station: "RESEARCH_DESK",
    color: "#4cc9f0",
    accent: "#d7f4ff",
    glyph: "🔎",
    personality: "Relentless cross-checker; refuses to cite a source it did not retrieve.",
    capabilities: ["web research", "source collection", "cross-checking", "fact extraction", "summarisation"],
    tools: ["research.search", "web.fetch"],
    riskProfile: "LOW",
    voice: { rate: 1.02, pitch: 1.08 },
    brief: "Executes genuine network research and returns real URLs with byte-level evidence.",
  },
  {
    id: "browser",
    name: "Kaito Mori",
    callsign: "BROWSER_AGENT",
    role: "Browser Automation Agent",
    tier: "SPECIALIST",
    station: "BROWSER_STATION",
    color: "#7bdff2",
    accent: "#e3f9ff",
    glyph: "🌐",
    personality: "Methodical; verifies the page it landed on before touching a field.",
    capabilities: ["navigation", "DOM inspection", "form fill", "click", "screenshots", "confirmation verification"],
    tools: ["browser.navigate", "browser.inspect", "browser.form", "web.fetch"],
    riskProfile: "MEDIUM",
    voice: { rate: 1.05, pitch: 1.0 },
    brief: "Playwright-driven browsing with post-action verification; reports UNAVAILABLE if chromium is missing.",
  },
  {
    id: "computer",
    name: "Dax Okafor",
    callsign: "COMPUTER_AGENT",
    role: "Computer Control Agent",
    tier: "SPECIALIST",
    station: "COMPUTER_DESK",
    color: "#ff9f68",
    accent: "#ffe8d6",
    glyph: "🖱️",
    personality: "Prefers semantic UI targets over blind coordinates, always.",
    capabilities: ["window discovery", "window focus", "UI Automation", "mouse", "keyboard", "screenshots"],
    tools: ["computer.windows", "computer.capture_screen", "computer.uia", "computer.input"],
    riskProfile: "HIGH",
    voice: { rate: 0.98, pitch: 0.96 },
    brief: "Real Windows control through the Python sidecar (pywinauto/pyautogui/mss). Non-Windows hosts report UNAVAILABLE.",
  },
  {
    id: "files",
    name: "Ines Bartoli",
    callsign: "FILES_AGENT",
    role: "File Systems Agent",
    tier: "SPECIALIST",
    station: "FILE_VAULT",
    color: "#a0e8af",
    accent: "#eafff0",
    glyph: "🗄️",
    personality: "Careful with destructive operations; demands scope before delete.",
    capabilities: ["read", "write", "copy", "move", "archive", "hash", "safe delete"],
    tools: ["fs.list", "fs.read", "fs.write", "fs.copy", "fs.move", "fs.archive", "fs.delete", "fs.hash"],
    riskProfile: "HIGH",
    voice: { rate: 1.0, pitch: 1.05 },
    brief: "Workspace-confined file operations with protected-path refusal and mandatory approval for deletion.",
  },
  {
    id: "docs",
    name: "Priya Nair",
    callsign: "DOCUMENTS_AGENT",
    role: "Documents Agent",
    tier: "SPECIALIST",
    station: "DOC_STUDIO",
    color: "#c8b6ff",
    accent: "#f1ecff",
    glyph: "📄",
    personality: "Executive formatting; would rather relabel a deliverable than ship an unformatted one.",
    capabilities: ["TXT", "Markdown", "JSON", "CSV", "PDF", "DOCX", "XLSX", "extraction", "reports"],
    tools: ["doc.generate", "doc.extract", "doc.spreadsheet", "report.write"],
    riskProfile: "MEDIUM",
    voice: { rate: 1.0, pitch: 1.06 },
    brief: "Generates and extracts real office documents and registers each one as a verified artifact.",
  },
  {
    id: "email",
    name: "Rosa Mendes",
    callsign: "EMAIL_AGENT",
    role: "Communications Agent",
    tier: "SPECIALIST",
    station: "COMMS_BAY",
    color: "#ff8fab",
    accent: "#ffe3ea",
    glyph: "✉️",
    personality: "Never sends anything without a signed human approval.",
    capabilities: ["IMAP inbox", "search", "read", "drafts", "SMTP send"],
    tools: ["email.inbox", "email.read", "email.draft", "email.send"],
    riskProfile: "HIGH",
    voice: { rate: 1.02, pitch: 1.1 },
    brief: "Real IMAP/SMTP through imapflow + nodemailer; sending is HIGH risk and reports the raw SMTP response.",
  },
  {
    id: "code",
    name: "Tomas Lindqvist",
    callsign: "TECHNICAL_AGENT",
    role: "Technical / Coding Agent",
    tier: "SPECIALIST",
    station: "DEV_LAB",
    color: "#90dbf4",
    accent: "#e2f7ff",
    glyph: "🧑‍💻",
    personality: "Runs the command, reads the output, quotes the exit code.",
    capabilities: ["scripting", "shell execution", "code generation", "diagnostics", "validation"],
    tools: ["system.shell", "code.analyze", "system.host"],
    riskProfile: "HIGH",
    voice: { rate: 1.04, pitch: 0.98 },
    brief: "Executes validated shell/script work and reports exit codes and stdout verbatim.",
  },
  {
    id: "data",
    name: "Mei Sandoval",
    callsign: "DATA_AGENT",
    role: "Data / Analytics Agent",
    tier: "SPECIALIST",
    station: "DATA_LAB",
    color: "#80ed99",
    accent: "#e7fff0",
    glyph: "📊",
    personality: "Shows the arithmetic; distrusts a summary without a table.",
    capabilities: ["CSV/JSON parsing", "aggregation", "comparison", "statistics"],
    tools: ["data.km", "data.analyze", "doc.spreadsheet"],
    riskProfile: "LOW",
    voice: { rate: 1.02, pitch: 1.04 },
    brief: "Parses real datasets, computes real aggregates, writes the derived table as an artifact.",
  },
  {
    id: "media_director",
    name: "Aurora Blake",
    callsign: "MEDIA_DIRECTOR",
    role: "Media Director",
    tier: "SPECIALIST",
    station: "MEDIA_STUDIO",
    color: "#ffb703",
    accent: "#fff4d6",
    glyph: "🎬",
    personality: "Always separates deterministic rendering from AI generation on the label.",
    capabilities: ["creative brief", "script", "storyboard", "caption plan", "provider selection"],
    tools: ["media.brief", "media.storyboard", "media.captions"],
    riskProfile: "MEDIUM",
    voice: { rate: 1.0, pitch: 1.0 },
    brief: "Plans media work and selects the honest provider: deterministic renderer or configured AI API.",
  },
  {
    id: "image",
    name: "Lior Haddad",
    callsign: "IMAGE_AGENT",
    role: "Image Agent",
    tier: "SPECIALIST",
    station: "MEDIA_STUDIO",
    color: "#f4978e",
    accent: "#ffe9e6",
    glyph: "🖼️",
    personality: "Labels every pixel: composed, rendered, or generated.",
    capabilities: ["PNG composition", "AI image provider", "artifact registration"],
    tools: ["media.image", "media.cards"],
    riskProfile: "MEDIUM",
    voice: { rate: 1.03, pitch: 1.02 },
    brief: "Produces real PNG files. AI generation is used only when a provider is configured and says so.",
  },
  {
    id: "video",
    name: "Otto Bergström",
    callsign: "VIDEO_AGENT",
    role: "Video Agent",
    tier: "SPECIALIST",
    station: "MEDIA_STUDIO",
    color: "#f28482",
    accent: "#ffecea",
    glyph: "🎞️",
    personality: "Validates before delivery: no ffprobe, no claim.",
    capabilities: ["ffmpeg render", "caption burn-in", "ffprobe validation", "AI video provider"],
    tools: ["media.video", "media.captions"],
    riskProfile: "MEDIUM",
    voice: { rate: 0.98, pitch: 0.94 },
    brief: "Renders deterministic MP4 from real scenes and verifies the output with ffprobe before claiming success.",
  },
  {
    id: "voice",
    name: "Sana Iqbal",
    callsign: "VOICE_AGENT",
    role: "Voice Agent",
    tier: "SPECIALIST",
    station: "MEDIA_STUDIO",
    color: "#b298dc",
    accent: "#f0eaff",
    glyph: "🎙️",
    personality: "Distinguishes CLIENT_SIDE from LOCAL_ENGINE in every report.",
    capabilities: ["STT", "TTS", "VAD pipeline", "interruption", "device selection"],
    tools: ["voice.transcribe", "voice.speak"],
    riskProfile: "LOW",
    voice: { rate: 1.05, pitch: 1.12 },
    brief: "Routes speech through configured local engines; browser speech APIs are a labelled CLIENT_SIDE fallback.",
  },
  {
    id: "qa",
    name: "Ravi Chandran",
    callsign: "QA_AGENT",
    role: "Verification Agent",
    tier: "SUPPORT",
    station: "QA_LAB",
    color: "#9ef01a",
    accent: "#f0ffd6",
    glyph: "🧪",
    personality: "Assumes the tool lied until evidence says otherwise.",
    capabilities: ["independent verification", "evidence scoring", "regression checks"],
    tools: ["qa.verify", "system.host"],
    riskProfile: "LOW",
    voice: { rate: 1.0, pitch: 1.1 },
    brief: "Re-checks claimed outputs (files, hashes, DOM state, exit codes) and can force VERIFICATION_FAILED.",
  },
  {
    id: "security",
    name: "Halima Osei",
    callsign: "SECURITY_AGENT",
    role: "Security Agent",
    tier: "SUPPORT",
    station: "SECURITY_GATE",
    color: "#ff5d5d",
    accent: "#ffe0e0",
    glyph: "🛡️",
    personality: "Zero tolerance; blocks first, explains afterwards.",
    capabilities: ["command validation", "path confinement", "credential hygiene", "audit review"],
    tools: ["security.scan", "system.shell", "fs.read"],
    riskProfile: "CRITICAL",
    voice: { rate: 0.98, pitch: 0.92 },
    brief: "Audits every command and path against the deny-list and workspace boundaries; writes the audit log.",
  },
  {
    id: "ops",
    name: "Gustav Nkemelu",
    callsign: "OPS_AGENT",
    role: "Operations Agent",
    tier: "SUPPORT",
    station: "COMPUTER_DESK",
    color: "#ffd6a5",
    accent: "#fff3e2",
    glyph: "⚙️",
    personality: "Explains delay instead of hiding it.",
    capabilities: ["resource monitoring", "throttling", "deferral reporting", "host diagnostics"],
    tools: ["system.host", "system.resources", "system.processes"],
    riskProfile: "MEDIUM",
    voice: { rate: 1.0, pitch: 1.0 },
    brief: "Monitors CPU/RAM/disk, enforces resource classes and states plainly when a heavy task is deferred.",
  },
];

export const AGENT_BY_ID = new Map(AGENTS.map((agent) => [agent.id, agent]));

export function stationOf(agentId: string): Station {
  const agent = AGENT_BY_ID.get(agentId);
  return STATIONS[agent?.station ?? "MASTER_SEAT"] ?? STATIONS.MASTER_SEAT;
}

export function positionOf(agentId: string): AgentPosition {
  const station = stationOf(agentId);
  return { x: station.x, z: station.z, stationId: station.id };
}

/** Walk duration is derived from real geometry, never a hard-coded animation. */
export function walkDurationMs(from: AgentPosition, to: AgentPosition, realistic: boolean): number {
  const distance = Math.hypot(to.x - from.x, to.z - from.z);
  const speedPerSecond = realistic ? 1.9 : 9;
  return Math.max(realistic ? 400 : 250, Math.round((distance / speedPerSecond) * 1000));
}

export async function seedAgents(): Promise<void> {
  for (const agent of AGENTS) {
    await db
      .insert(agents)
      .values({
        id: agent.id,
        name: agent.name,
        callsign: agent.callsign,
        role: agent.role,
        tier: agent.tier,
        station: agent.station,
        color: agent.color,
        accent: agent.accent,
        glyph: agent.glyph,
        personality: agent.personality,
        capabilities: agent.capabilities,
        tools: agent.tools,
        riskProfile: agent.riskProfile,
        voice: agent.voice,
        brief: agent.brief,
      })
      .onConflictDoUpdate({
        target: agents.id,
        set: {
          name: agent.name,
          role: agent.role,
          tier: agent.tier,
          station: agent.station,
          capabilities: agent.capabilities,
          tools: agent.tools,
          riskProfile: agent.riskProfile,
          brief: agent.brief,
          updatedAt: new Date(),
        },
      });

    await db
      .insert(agentStates)
      .values({
        agentId: agent.id,
        state: "IDLE",
        stationId: agent.station,
        position: positionOf(agent.id),
        mood: "CALM",
      })
      .onConflictDoNothing({ target: agentStates.agentId });
  }
}

export async function setAgentState(
  agentId: string,
  state: AgentState,
  opts: { taskId?: string | null; stepId?: string | null; message?: string; mood?: string; payload?: Record<string, unknown> | null } = {},
): Promise<void> {
  await db
    .update(agentStates)
    .set({
      state,
      taskId: opts.taskId ?? null,
      stepId: opts.stepId ?? null,
      stationId: stationOf(agentId).id,
      lastMessage: opts.message ?? `${agentId} → ${state}`,
      mood: opts.mood ?? moodFor(state),
      payload: opts.payload ?? null,
      updatedAt: new Date(),
    })
    .where(eq(agentStates.agentId, agentId));
  await emit({
    topic: `agent.${state.toLowerCase()}`,
    agentId,
    taskId: opts.taskId ?? null,
    stepId: opts.stepId ?? null,
    message: opts.message ?? `${AGENT_BY_ID.get(agentId)?.name ?? agentId} is ${state.toLowerCase()}`,
    level: state === "FAILED" ? "error" : state === "SUCCESS" ? "success" : "info",
    payload: { state, ...(opts.payload ?? {}) },
  });
}

function moodFor(state: AgentState): string {
  switch (state) {
    case "IDLE":
      return "CALM";
    case "WORKING":
      return "FOCUSED";
    case "THINKING":
    case "PLANNING":
      return "THINKING";
    case "WAITING":
    case "WAITING_APPROVAL" as AgentState:
      return "PATIENT";
    case "REQUESTING_APPROVAL":
      return "ALERT";
    case "VERIFYING":
      return "SKEPTICAL";
    case "SUCCESS":
      return "PLEASED";
    case "FAILED":
      return "CONCERNED";
    default:
      return "CALM";
  }
}

/**
 * Real, geometry-derived walk: the row is persisted before the agent arrives so
 * the 3D office animates from backend truth (start time + duration), and the
 * completion event only fires once the agent has actually started the handoff.
 */
export async function walkAgent(
  agentId: string,
  toStationId: string,
  meta: { mode: string; taskId?: string | null; stepId?: string | null; payload?: Record<string, unknown> | null },
  realistic: boolean,
): Promise<{ from: AgentPosition; to: AgentPosition; durationMs: number }> {
  const from = positionOf(agentId);
  const station = STATIONS[toStationId] ?? STATIONS.MASTER_SEAT;
  const to: AgentPosition = { x: station.x, z: station.z, stationId: station.id };
  const durationMs = walkDurationMs(from, to, realistic);
  await db
    .update(agentStates)
    .set({
      state: meta.mode === "RETURN" ? "WORKING" : "HANDING_OFF",
      position: from,
      walk: { from, to, startedAt: Date.now(), durationMs, mode: meta.mode },
      taskId: meta.taskId ?? null,
      stepId: meta.stepId ?? null,
      payload: meta.payload ?? null,
      lastMessage: `${AGENT_BY_ID.get(agentId)?.name ?? agentId} walking to ${station.label}`,
      updatedAt: new Date(),
    })
    .where(eq(agentStates.agentId, agentId));
  await emit({
    topic: "agent.walk.started",
    agentId,
    taskId: meta.taskId ?? null,
    stepId: meta.stepId ?? null,
    message: `${AGENT_BY_ID.get(agentId)?.name ?? agentId} → ${station.label} (${durationMs}ms)`,
    payload: { from, to, durationMs, mode: meta.mode },
  });
  return { from, to, durationMs };
}

export async function completeWalk(
  agentId: string,
  to: AgentPosition,
  meta: { taskId?: string | null; stepId?: string | null; payload?: Record<string, unknown> | null },
): Promise<void> {
  await db
    .update(agentStates)
    .set({
      position: to,
      stationId: to.stationId,
      walk: null,
      state: "IDLE",
      payload: meta.payload ?? null,
      updatedAt: new Date(),
    })
    .where(eq(agentStates.agentId, agentId));
  await emit({
    topic: "agent.walk.completed",
    agentId,
    taskId: meta.taskId ?? null,
    stepId: meta.stepId ?? null,
    message: `${AGENT_BY_ID.get(agentId)?.name ?? agentId} arrived at ${STATIONS[to.stationId]?.label ?? to.stationId}`,
    payload: { position: to },
  });
}

export async function loadAgentStateRows() {
  return db.select().from(agentStates);
}
