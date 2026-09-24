import type { WorkspaceRoots } from "@/lib/workspace";
import type { ProviderReport } from "@/lib/providers";

export type ArtifactSpec = {
  kind: string;
  name: string;
  absPath: string;
  mime?: string;
  meta?: Record<string, unknown>;
  validated?: boolean;
};

export type ToolProgress = (message: string, data?: Record<string, unknown>) => Promise<void>;

/**
 * Runtime context handed to every tool handler. `handle`/`loadHandle` give tools
 * a durable, task-scoped way to pass structured intermediate state (script,
 * storyboard, alignment...) between agents inside the run directory.
 */
export type ToolContext = {
  taskId: string;
  runId: string;
  stepId: string;
  agentId: string;
  runDir: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  progress: ToolProgress;
  handle: (handleId: string, value: unknown) => Promise<string>;
  loadHandle: <T>(handleId: string) => Promise<T | null>;
  findings: Record<string, unknown>;
  providers: ProviderReport[];
  workspace: WorkspaceRoots;
  allowedCommands: string[];
  tenant: { cloudLlmEnabled: boolean; ollamaUrl: string; ollamaModel: string; whisperUrl?: string; ttsUrl?: string };
};

export type ToolResult = {
  ok: boolean;
  summary: string;
  /** Concise operational summary the agent may speak aloud in the 3D office. */
  agentMessage?: string;
  output?: Record<string, unknown>;
  artifacts?: ArtifactSpec[];
  error?: string;
  diagnostics?: Record<string, unknown>;
  /** Marks a step that legitimately needs user input; the task pauses honestly. */
  needsInput?: boolean;
};

export type ToolHandler = (ctx: ToolContext) => Promise<ToolResult>;

export function fail(summary: string, error: string, diagnostics?: Record<string, unknown>): ToolResult {
  return { ok: false, summary, error, diagnostics };
}

export function ok(summary: string, output: Record<string, unknown> = {}, agentMessage?: string, artifacts?: ArtifactSpec[]): ToolResult {
  return { ok: true, summary, output, agentMessage, artifacts };
}
