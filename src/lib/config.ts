import { promises as fs } from "node:fs";
import path from "node:path";

export type AppConfig = {
  autonomy: {
    maxConcurrentSteps: number;
    maxConcurrentHeavy: number;
    maxStepAttempts: number;
    stepTimeoutMs: number;
    taskTimeoutMs: number;
    walkRealism: boolean;
  };
  approvals: { ttlMinutes: number; enforceActionHash: boolean };
  uploads: { maxBytes: number; allowedExtensions: string[] };
  media: {
    fps: number;
    crf: number;
    resolution: { width: number; height: number };
    videoCodec: string;
    audioCodec: string;
  };
  resource: { minFreeRamMb: number; heavyCpuLoadPerCore: number; sampleIntervalMs: number };
  workspace: { protectedPaths: string[] };
};

export type ProvidersConfig = {
  statuses: string[];
  [key: string]: unknown;
};

const DEFAULTS: AppConfig = {
  autonomy: {
    maxConcurrentSteps: 4,
    maxConcurrentHeavy: 1,
    maxStepAttempts: 2,
    stepTimeoutMs: 120_000,
    taskTimeoutMs: 900_000,
    walkRealism: true,
  },
  approvals: { ttlMinutes: 15, enforceActionHash: true },
  uploads: { maxBytes: 104_857_600, allowedExtensions: [".txt", ".md", ".json", ".csv", ".pdf", ".docx", ".xlsx", ".png"] },
  media: {
    fps: 24,
    crf: 26,
    resolution: { width: 1280, height: 720 },
    videoCodec: "libx264",
    audioCodec: "aac",
  },
  resource: { minFreeRamMb: 400, heavyCpuLoadPerCore: 1.6, sampleIntervalMs: 5000 },
  workspace: {
    protectedPaths: ["C:\\Windows", "C:\\Program Files", "/etc", "/bin", "/sbin", "/usr", "/boot", "/proc", "/sys", "/dev"],
  },
};

export const ROOT = process.env.AISHA_ROOT ? path.resolve(process.env.AISHA_ROOT) : process.cwd();

export const DIRS = {
  root: ROOT,
  workspace: path.join(ROOT, "workspace"),
  artifacts: path.join(ROOT, "artifacts"),
  logs: path.join(ROOT, "logs"),
  runs: path.join(ROOT, "runs"),
  uploads: path.join(ROOT, "uploads"),
  migrations: path.join(ROOT, "migrations"),
  config: path.join(ROOT, "config"),
  python: path.join(ROOT, "python"),
};

export const IS_WINDOWS = process.platform === "win32";

let cachedApp: AppConfig | null = null;
let cachedProviders: ProvidersConfig | null = null;

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function appConfig(): Promise<AppConfig> {
  if (cachedApp) return cachedApp;
  const loaded = await readJson<Partial<AppConfig>>(path.join(DIRS.config, "app.json"), {});
  cachedApp = {
    ...DEFAULTS,
    ...loaded,
    autonomy: { ...DEFAULTS.autonomy, ...(loaded.autonomy ?? {}) },
    approvals: { ...DEFAULTS.approvals, ...(loaded.approvals ?? {}) },
    uploads: { ...DEFAULTS.uploads, ...(loaded.uploads ?? {}) },
    media: { ...DEFAULTS.media, ...(loaded.media ?? {}) },
    resource: { ...DEFAULTS.resource, ...(loaded.resource ?? {}) },
    workspace: { ...DEFAULTS.workspace, ...(loaded.workspace ?? {}) },
  };
  return cachedApp;
}

export async function providersConfig(): Promise<ProvidersConfig> {
  if (cachedProviders) return cachedProviders;
  cachedProviders = await readJson<ProvidersConfig>(path.join(DIRS.config, "providers.json"), { statuses: [] });
  return cachedProviders;
}

export async function ensureRuntimeDirs(): Promise<void> {
  await Promise.all(
    [DIRS.workspace, DIRS.artifacts, DIRS.logs, DIRS.runs, DIRS.uploads].map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  );
}

export const OLLAMA_URL = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
export const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 60_000);
export const WHISPER_URL = process.env.WHISPER_URL?.replace(/\/$/, "");
export const TTS_URL = process.env.TTS_URL?.replace(/\/$/, "");
export const PYTHON_BIN = process.env.AISHA_PYTHON ?? (IS_WINDOWS ? "python" : "python3");
export const SIDECAR_PATH = process.env.AISHA_SIDECAR ?? path.join(DIRS.python, "worker", "aisha_worker.py");
export const ALLOWED_COMMANDS = (process.env.AISHA_ALLOWED_COMMANDS ?? "")
  .split(",")
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);
export const CLOUD_LLM_ENABLED = process.env.AISHA_ENABLE_CLOUD_LLM === "true";
