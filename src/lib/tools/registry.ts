/**
 * Tool registry — ONE registry, ONE execution path.
 *
 * runTool() is the only way a tool is ever executed. It enforces, in order:
 *   1. schema validation      (bad parameters never reach an executor)
 *   2. live availability      (UNAVAILABLE is reported, never faked)
 *   3. approval enforcement   (HIGH/CRITICAL risk requires a signed, hash-matched token)
 *   4. cancellation + timeout (real AbortSignal, never a UI-only flag)
 *   5. audit + event + tool-run persistence
 */
import { db } from "@/db";
import { toolRuns } from "@/db/schema";
import type { RiskLevel } from "@/db/schema";
import { appConfig } from "@/lib/config";
import { emit } from "@/lib/events";
import { isAbort, newId, errorMessage, hashAction, truncate } from "@/lib/util";
import { registerArtifact } from "@/lib/artifacts";
import type { ToolContext, ToolDefinition, ToolResult } from "@/lib/tools/types";

const registry = new Map<string, ToolDefinition<never>>();

export function registerTool<P>(definition: ToolDefinition<P>): void {
  if (registry.has(definition.id)) {
    throw new Error(`duplicate tool id in registry: ${definition.id}`);
  }
  registry.set(definition.id, definition as unknown as ToolDefinition<never>);
}

export function getTool(id: string): ToolDefinition<never> | undefined {
  return registry.get(id);
}

export function listTools(): ToolDefinition<never>[] {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function toolsForAgent(agentId: string): ToolDefinition<never>[] {
  return listTools().filter((tool) => tool.agents.includes(agentId));
}

export function requiresApproval(risk: RiskLevel): boolean {
  return risk === "HIGH" || risk === "CRITICAL";
}

export type RunToolInput = {
  toolId: string;
  params: Record<string, unknown>;
  ctx: Omit<ToolContext, "log"> & { log?: ToolContext["log"] };
};

export async function runTool(input: RunToolInput): Promise<ToolResult> {
  const tool = registry.get(input.toolId);
  const started = Date.now();
  const config = await appConfig();
  const log =
    input.ctx.log ??
    (async (message: string, payload?: Record<string, unknown>) => {
      await emit({
        topic: "tool.progress",
        taskId: input.ctx.taskId,
        stepId: input.ctx.stepId,
        agentId: input.ctx.agentId,
        message,
        payload: payload ?? {},
      });
    });

  if (!tool) {
    return finish(input, "FAILED", `unknown tool id "${input.toolId}"`, started, "FAILED");
  }
  if (!tool.agents.includes(input.ctx.agentId)) {
    return finish(input, "BLOCKED", `agent ${input.ctx.agentId} is not permitted to request ${tool.id}`, started, "BLOCKED");
  }

  const parsed = tool.params.safeParse(input.params);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; ");
    await log(`parameter validation failed: ${issues}`);
    return finish(input, "FAILED", `invalid parameters — ${issues}`, started, "FAILED");
  }

  const available = await tool.availability();
  if (!available.available) {
    await log(`unavailable: ${available.detail}`);
    const result: ToolResult = {
      status: "UNAVAILABLE",
      summary: `${tool.id} unavailable: ${available.detail}`,
      evidence: [{ kind: "availability-probe", detail: available.detail }],
      artifacts: [],
      data: { fix: available.fix },
    };
    return finish(input, "UNAVAILABLE", result.summary, started, "UNAVAILABLE", result);
  }

  const target = String(
    (input.params.target as string) ?? (input.params.path as string) ?? (input.params.url as string) ?? (input.params.to as string) ?? tool.id,
  );
  const actionHash = hashAction({ action: tool.id, target, params: input.params });
  const effectiveRisk = tool.riskFor ? tool.riskFor(parsed.data as never) : tool.risk;

  if (requiresApproval(effectiveRisk)) {
    const approval = input.ctx.approval;
    if (!approval?.granted) {
      const result: ToolResult = {
        status: "BLOCKED",
        summary: `${tool.id} requires a human approval (${effectiveRisk} risk) before execution`,
        evidence: [{ kind: "approval-gate", detail: `no granted approval for hash ${actionHash.slice(0, 12)}` }],
        artifacts: [],
      };
      return finish(input, "BLOCKED", result.summary, started, "BLOCKED", result);
    }
    if (approval.actionHash !== actionHash) {
      const result: ToolResult = {
        status: "BLOCKED",
        summary: `${tool.id} approval token does not match the current parameters (hash mismatch)`,
        evidence: [
          { kind: "approval-gate", detail: `token hash ${approval.actionHash.slice(0, 12)} ≠ action hash ${actionHash.slice(0, 12)}` },
        ],
        artifacts: [],
      };
      return finish(input, "BLOCKED", result.summary, started, "BLOCKED", result);
    }
  }

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  input.ctx.signal.addEventListener("abort", onOuterAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), config.autonomy.stepTimeoutMs);

  await emit({
    topic: "tool.started",
    taskId: input.ctx.taskId,
    stepId: input.ctx.stepId,
    agentId: input.ctx.agentId,
    message: `${tool.id} started${target !== tool.id ? ` → ${truncate(target, 120)}` : ""}`,
    payload: { toolId: tool.id, risk: effectiveRisk, params: sanitize(input.params) },
  });

  let result: ToolResult;
  try {
    const ctx: ToolContext = { ...input.ctx, log };
    result = await tool.execute(ctx, parsed.data as never);

    if (result.artifacts?.length) {
      const registered = [];
      for (const artifact of result.artifacts) {
        try {
          const row = await registerArtifact({
            ...artifact,
            taskId: input.ctx.taskId,
            stepId: input.ctx.stepId,
            agentId: input.ctx.agentId,
          });
          registered.push({ id: row.id, name: row.name, kind: row.kind, bytes: row.bytes, sha256: row.sha256 });
        } catch (error) {
          result.evidence.push({ kind: "artifact-registration", detail: `FAILED for ${artifact.filePath}: ${errorMessage(error)}` });
          result.status = "VERIFICATION_FAILED";
          result.summary = `${result.summary} — artifact registration failed: ${errorMessage(error)}`;
        }
      }
      result.data = { ...(result.data ?? {}), artifacts: registered };
      result.artifacts = [];
    }

    if (tool.verify && result.status === "SUCCESS") {
      const verification = await tool.verify(ctx, parsed.data as never, result);
      result.verification = verification;
      if (!verification.verified) {
        result.status = "VERIFICATION_FAILED";
        result.summary = `verification failed: ${verification.detail}`;
      }
    }
  } catch (error) {
    if (isAbort(error)) {
      result = {
        status: input.ctx.signal.aborted ? "CANCELLED" : "TIMEOUT",
        summary: input.ctx.signal.aborted ? `${tool.id} cancelled by user` : `${tool.id} exceeded ${config.autonomy.stepTimeoutMs}ms`,
        evidence: [{ kind: "execution", detail: errorMessage(error) }],
        artifacts: [],
      };
    } else {
      result = {
        status: "FAILED",
        summary: `${tool.id} threw: ${errorMessage(error)}`,
        evidence: [{ kind: "execution", detail: errorMessage(error) }],
        artifacts: [],
        reason: errorMessage(error),
      };
    }
  } finally {
    clearTimeout(timeout);
    input.ctx.signal.removeEventListener("abort", onOuterAbort);
  }

  return finish(input, result.status, result.summary, started, result.status, result);
}

function sanitize(params: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(params ?? {})) as Record<string, unknown>;
  for (const key of ["password", "token", "secret", "apiKey"]) {
    if (key in clone) clone[key] = "***";
  }
  if (typeof clone.content === "string" && clone.content.length > 2000) clone.content = `${clone.content.slice(0, 2000)}…`;
  if (typeof clone.command === "string" && clone.command.length > 1000) clone.command = `${clone.command.slice(0, 1000)}…`;
  return clone;
}

async function finish(
  input: RunToolInput,
  status: string,
  summary: string,
  started: number,
  resultStatus: string,
  result?: ToolResult,
): Promise<ToolResult> {
  const ms = Date.now() - started;
  const finalResult: ToolResult =
    result ?? { status: "FAILED", summary, evidence: [{ kind: "registry", detail: summary }], artifacts: [], reason: summary };

  await db
    .insert(toolRuns)
    .values({
      id: newId("run"),
      taskId: input.ctx.taskId,
      stepId: input.ctx.stepId,
      toolId: input.toolId,
      risk: (getTool(input.toolId)?.risk ?? "LOW") as RiskLevel,
      status: resultStatus,
      ms,
      params: sanitize(input.params),
      result: finalResult.data ? (JSON.parse(JSON.stringify(finalResult.data)) as Record<string, unknown>) : { summary },
      error: resultStatus === "SUCCESS" ? null : truncate(summary, 2000),
    })
    .catch(() => undefined);

  await emit({
    topic: "tool.completed",
    taskId: input.ctx.taskId,
    stepId: input.ctx.stepId,
    agentId: input.ctx.agentId,
    level: resultStatus === "SUCCESS" ? "success" : resultStatus === "CANCELLED" ? "warn" : "error",
    message: `${input.toolId} → ${resultStatus} in ${ms}ms: ${truncate(summary, 300)}`,
    payload: { toolId: input.toolId, status: resultStatus, ms },
  });

  return { ...finalResult, status: status as ToolResult["status"] };
}
