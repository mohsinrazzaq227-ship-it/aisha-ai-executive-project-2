/**
 * Tool contract shared by every capability in AISHA.
 *
 * A tool declares its risk, its resource class, the agents allowed to request
 * it, a strict Zod parameter schema, an executor, and — critically — how its
 * success is independently verified. Tools may not claim success on their own.
 */
import type { z } from "zod";
import type { RiskLevel, ResourceClass } from "@/db/schema";

export type ToolStatus =
  | "SUCCESS"
  | "FAILED"
  | "TIMEOUT"
  | "CANCELLED"
  | "BLOCKED"
  | "UNAVAILABLE"
  | "VERIFICATION_FAILED";

export type ArtifactInput = {
  name: string;
  kind: string;
  /** Absolute path to a real file on disk. Registration re-reads it and hashes it. */
  filePath: string;
  mimeType: string;
  origin?: "deterministic" | "ai-generated" | "retrieved" | "user-upload";
  validation?: { valid: boolean; method: string; detail: string };
};

export type Evidence = { kind: string; detail: string; ref?: string };

export type ToolResult = {
  status: ToolStatus;
  summary: string;
  data?: Record<string, unknown>;
  artifacts?: ArtifactInput[];
  evidence: Evidence[];
  reason?: string;
  /** Optional tool-local verification. The step still cannot pass without it. */
  verification?: { verified: boolean; method: string; detail: string };
};

export type ToolContext = {
  taskId: string;
  stepId: string;
  agentId: string;
  signal: AbortSignal;
  approval: { granted: boolean; token: string; actionHash: string } | null;
  log: (message: string, payload?: Record<string, unknown>) => Promise<void>;
};

export type ToolDefinition<P = Record<string, unknown>> = {
  id: string;
  title: string;
  group: "system" | "fs" | "docs" | "data" | "web" | "email" | "media" | "voice" | "computer" | "qa" | "security";
  description: string;
  risk: RiskLevel;
  /** Parameter-dependent escalation, e.g. writing outside the workspace. */
  riskFor?: (params: P) => RiskLevel;
  resourceClass: ResourceClass;
  /** Agents permitted to *request* this tool. The supervisor may not invent others. */
  agents: string[];
  params: z.ZodType<P>;
  /** Human-readable statement of how this tool's output is verified. */
  verificationNote: string;
  availability: () => Promise<{ available: boolean; detail: string; fix?: string }>;
  execute: (ctx: ToolContext, params: P) => Promise<ToolResult>;
  verify?: (ctx: ToolContext, params: P, result: ToolResult) => Promise<{ verified: boolean; method: string; detail: string }>;
};

export function ok(summary: string, data?: Record<string, unknown>, evidence: Evidence[] = []): ToolResult {
  return { status: "SUCCESS", summary, data, evidence, artifacts: [] };
}

export function fail(status: Exclude<ToolStatus, "SUCCESS">, summary: string, evidence: Evidence[] = [], data?: Record<string, unknown>): ToolResult {
  return { status, summary, data, evidence, artifacts: [], reason: summary };
}

export function unavailable(summary: string, fix: string, evidence: Evidence[] = []): ToolResult {
  return {
    status: "UNAVAILABLE",
    summary,
    evidence,
    artifacts: [],
    reason: summary,
    data: { fix },
  };
}
