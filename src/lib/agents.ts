import type { RiskLevel } from "@/db/schema";
import { STATIONS, type StationId } from "@/lib/nav";

export type AgentDefinition = {
  id: string;
  name: string;
  role: string;
  callsign: string;
  station: StationId;
  color: string;
  accent: string;
  glyph: string;
  capabilities: string[];
  tools: string[];
  /** Highest risk class this agent is permitted to *request* (never bypass approval). */
  riskProfile: RiskLevel;
  voice: { rate: number; pitch: number };
  brief: string;
};

export const AGENTS: AgentDefinition[] = [
  {
    id: "master_supervisor",
    name: "AISHA",
    callsign: "MASTER_SUPERVISOR",
    role: "Master Supervisor",
    station: "MASTER_SEAT",
    color: "#f6c045",
    accent: "#fff3cf",
    glyph: "👑",
    capabilities: ["intent understanding", "planning", "delegation", "risk classification", "verification", "user reporting"],
    tools: ["supervisor.answer", "report.write", "shell.execute", "email.send"],
    riskProfile: "HIGH",
    voice: { rate: 1.0, pitch: 1.02 },
    brief: "Single point of authority. Receives your request, plans it, classifies risk, delegates to specialists and verifies results.",
  },
  {
    id: "research_agent",
    name: "Nova Reyes",
    callsign: "RESEARCH_AGENT",
    role: "Research Agent",
    station: "RESEARCH_DESK",
    color: "#4cc9f0",
    accent: "#d7f4ff",
    glyph: "🔎",
    capabilities: ["web research", "source collection", "cross-checking", "fact extraction", "summarisation"],
    tools: ["research.search", "research.extract", "report.write"],
    riskProfile: "LOW",
    voice: { rate: 1.02, pitch: 1.08 },
    brief: "Performs genuine network research and returns real sources with URLs — no fabricated citations.",
  },
  {
    id: "browser_agent",
    name: "Kaito Mori",
    callsign: "BROWSER_AGENT",
    role: "Browser Automation Agent",
    station: "RESEARCH_DESK",
    color: "#7bdff2",
    accent: "#e3f9ff",
    glyph: "🌐",
    capabilities: ["page navigation", "DOM extraction", "pagination", "link following"],
    tools: ["browser.fetch", "research.extract"],
    riskProfile: "MEDIUM",
    voice: { rate: 1.05, pitch: 1.0 },
    brief: "Navigates approved websites and extracts structured content. Playwright-driven when installed; otherwise HTTP fetch engine.",
  },
  {
    id: "computer_agent",
    name: "Dax Okafor",
    callsign: "COMPUTER_AGENT",
    role: "Computer Control Agent",
    station: "COMPUTER_DESK",
    color: "#ff9f68",
    accent: "#ffe8d6",
    glyph: "🖥️",
    capabilities: ["shell execution", "process inspection", "host diagnostics", "window control (Windows host layer)"],
    tools: ["shell.preview", "shell.execute", "host.inspect", "windows.control"],
    riskProfile: "HIGH",
    voice: { rate: 1.0, pitch: 0.94 },
    brief: "Executes host commands only after a validated allowlist check and an explicit, parameter-hashed approval.",
  },
  {
    id: "vision_agent",
    name: "Iris Lund",
    callsign: "VISION_AGENT",
    role: "Computer Vision Agent",
    station: "COMPUTER_DESK",
    color: "#b892ff",
    accent: "#efe4ff",
    glyph: "👁️",
    capabilities: ["screenshot inventory", "accessibility-tree priority", "OCR fallback", "coordinate proposal"],
    tools: ["vision.inventory", "vision.propose"],
    riskProfile: "MEDIUM",
    voice: { rate: 1.03, pitch: 1.12 },
    brief: "Reads the screen through structured APIs first (accessibility → DOM → OCR) and only proposes coordinate actions as a last resort.",
  },
  {
    id: "file_agent",
    name: "Bruno Feld",
    callsign: "FILE_AGENT",
    role: "File Agent",
    station: "ASSET_HUB",
    color: "#ffd166",
    accent: "#fff6d8",
    glyph: "🗂️",
    capabilities: ["list", "read", "write", "copy", "move", "rename", "hash", "metadata", "archive"],
    tools: ["fs.list", "fs.read", "fs.write", "fs.copy", "fs.move", "fs.archive", "fs.delete"],
    riskProfile: "HIGH",
    voice: { rate: 0.98, pitch: 0.9 },
    brief: "Real filesystem work inside the permitted scope. Deletion always requires HIGH-risk approval and is never silent.",
  },
  {
    id: "document_agent",
    name: "Priya Nandakumar",
    callsign: "DOCUMENT_AGENT",
    role: "Document Agent",
    station: "DOCUMENT_DESK",
    color: "#5ef0b0",
    accent: "#dcfff0",
    glyph: "📄",
    capabilities: ["PDF/DOCX/CSV/XLSX/TXT extraction", "comparison", "analysis", "generation"],
    tools: ["doc.extract", "doc.analyse", "doc.transform", "report.write"],
    riskProfile: "MEDIUM",
    voice: { rate: 1.0, pitch: 1.05 },
    brief: "Extracts and analyses documents you upload. Originals are never overwritten — derived files are always new artifacts.",
  },
  {
    id: "email_agent",
    name: "Selin Aydın",
    callsign: "EMAIL_AGENT",
    role: "Email Agent",
    station: "EMAIL_DESK",
    color: "#f78fb3",
    accent: "#ffe1ea",
    glyph: "✉️",
    capabilities: ["inbox listing", "thread summarisation", "draft replies", "send (guarded)"],
    tools: ["email.list", "email.summarise", "email.draft", "email.send"],
    riskProfile: "HIGH",
    voice: { rate: 1.02, pitch: 1.06 },
    brief: "Works only when an IMAP/SMTP/Gmail/Graph connector is explicitly configured. Sending is HIGH risk and always approved first.",
  },
  {
    id: "voice_agent",
    name: "Mira Solano",
    callsign: "VOICE_AGENT",
    role: "Voice Agent",
    station: "HOT_DESK",
    color: "#a0e7e5",
    accent: "#e6ffff",
    glyph: "🎙️",
    capabilities: ["speech-to-text", "voice activity detection", "speech synthesis queue", "interruption handling"],
    tools: ["voice.transcribe", "voice.speak"],
    riskProfile: "LOW",
    voice: { rate: 1.0, pitch: 1.0 },
    brief: "Owns the voice pipeline: real microphone capture, VAD, local Whisper when configured, TTS with true interruption.",
  },
  {
    id: "script_agent",
    name: "Hana Weiss",
    callsign: "SCRIPT_AGENT",
    role: "Scriptwriter Agent",
    station: "SCRIPT_DESK",
    color: "#ffb703",
    accent: "#fff0cc",
    glyph: "✍️",
    capabilities: ["narrative structure", "scriptwriting", "pacing", "audience adaptation"],
    tools: ["script.generate"],
    riskProfile: "LOW",
    voice: { rate: 1.01, pitch: 1.1 },
    brief: "Turns research into a coherent, adult, non-repetitive narration script sized to the requested duration.",
  },
  {
    id: "visual_agent",
    name: "Tomas Kraus",
    callsign: "VISUAL_AGENT",
    role: "Visual Agent",
    station: "MEDIA_DESK",
    color: "#8ecae6",
    accent: "#e0f5ff",
    glyph: "🎨",
    capabilities: ["visual type selection", "storyboard illustration", "diagram/chart/timeline composition"],
    tools: ["storyboard.generate", "visuals.render"],
    riskProfile: "LOW",
    voice: { rate: 1.03, pitch: 1.0 },
    brief: "Selects a genuinely different visual representation per scene and renders deterministic 1080x1920 frames.",
  },
  {
    id: "audio_agent",
    name: "Lena Petrova",
    callsign: "AUDIO_AGENT",
    role: "Audio Agent",
    station: "MEDIA_DESK",
    color: "#cdb4db",
    accent: "#f4ecf9",
    glyph: "🔊",
    capabilities: ["TTS orchestration", "audio bed synthesis", "loudness normalisation", "timestamp alignment"],
    tools: ["audio.narrate", "audio.bed", "audio.align"],
    riskProfile: "LOW",
    voice: { rate: 1.0, pitch: 1.08 },
    brief: "Produces narration when a TTS provider is available and always reports honestly which audio path was used.",
  },
  {
    id: "video_director",
    name: "Rafael Costa",
    callsign: "VIDEO_DIRECTOR",
    role: "Video Director",
    station: "MEDIA_DESK",
    color: "#f4978e",
    accent: "#ffe7e4",
    glyph: "🎬",
    capabilities: ["creative brief", "scene count planning", "camera language", "pacing", "quality bars"],
    tools: ["director.brief", "storyboard.generate"],
    riskProfile: "LOW",
    voice: { rate: 0.99, pitch: 0.92 },
    brief: "Writes the creative brief before a single frame exists and decides how many visual moments the topic really needs.",
  },
  {
    id: "video_renderer",
    name: "Otto Lindqvist",
    callsign: "VIDEO_RENDERER",
    role: "Video Renderer",
    station: "MEDIA_DESK",
    color: "#9aa5b1",
    accent: "#e7ecf2",
    glyph: "⚙️",
    capabilities: ["H.264 encoding", "Ken Burns motion", "caption burn-in", "transition composition", "atomic publish"],
    tools: ["media.render", "captions.render"],
    riskProfile: "MEDIUM",
    voice: { rate: 0.97, pitch: 0.88 },
    brief: "Renders with FFmpeg to temp, never publishing a partially rendered file. Reports real encoder parameters.",
  },
  {
    id: "validation_agent",
    name: "Anya Vogel",
    callsign: "VALIDATION_AGENT",
    role: "Validation Agent",
    station: "QUALITY_RACK",
    color: "#70e000",
    accent: "#e6ffcc",
    glyph: "✅",
    capabilities: ["ffprobe verification", "stream checks", "duration checks", "pixel format checks", "integrity gate"],
    tools: ["validation.ffprobe", "validation.file"],
    riskProfile: "LOW",
    voice: { rate: 1.02, pitch: 1.04 },
    brief: "Reads the produced file itself. Claims are only marked VALIDATED when the container, codecs, pixel format and audio are read back from disk.",
  },
  {
    id: "asset_manager",
    name: "Chen Wu",
    callsign: "ASSET_MANAGER",
    role: "Asset Manager",
    station: "ASSET_HUB",
    color: "#e0aaff",
    accent: "#f7ecff",
    glyph: "📦",
    capabilities: ["artifact manifest", "run directory layout", "provenance", "checksums"],
    tools: ["artifact.register", "manifest.write"],
    riskProfile: "LOW",
    voice: { rate: 1.0, pitch: 1.0 },
    brief: "Keeps every artifact linked to its task, run directory and manifest with checksums.",
  },
];

export const AGENT_MAP: Record<string, AgentDefinition> = Object.fromEntries(AGENTS.map((a) => [a.id, a]));

export function getAgent(id: string): AgentDefinition {
  return AGENT_MAP[id] ?? AGENT_MAP.master_supervisor;
}

/** Deterministic slot per agent so shared desks never overlap in 3D. */
export function agentSlot(agentId: string): number {
  const stationId = getAgent(agentId).station;
  const occupants = AGENTS.filter((a) => a.station === stationId).map((a) => a.id);
  const index = occupants.indexOf(agentId);
  return index < 0 ? 0 : index;
}

export function stationLabel(stationId: StationId): string {
  return STATIONS[stationId].label;
}

export type AgentLiveState = {
  agentId: string;
  callsign: string;
  name: string;
  role: string;
  glyph: string;
  color: string;
  accent: string;
  station: StationId;
  stationLabel: string;
  slot: number;
  state: string;
  mood: string;
  taskId: string | null;
  lastMessage: string | null;
  updatedAt: string;
  capabilities: string[];
};
