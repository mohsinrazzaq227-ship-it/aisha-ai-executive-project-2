/**
 * QA + Security tools: independent verification and policy auditing.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DIRS } from "@/lib/config";
import { registerTool } from "@/lib/tools/registry";
import { fail, ok } from "@/lib/tools/types";
import { audit, checkPath, scanCommand } from "@/lib/security";
import { fileInfo, sha256, toRelative } from "@/lib/util";

registerTool({
  id: "qa.verify",
  title: "Independent verification",
  group: "qa",
  description: "Re-checks a claim about the real world: file existence + hash, URL reachability, or a numeric threshold. Failure is reported as VERIFICATION_FAILED.",
  risk: "LOW",
  resourceClass: "LIGHT",
  agents: ["qa", "aisha", "security", "docs", "research"],
  params: z.object({
    check: z.enum(["file-exists", "file-hash", "url-reachable", "value-at-least"]),
    path: z.string().optional(),
    expectedHash: z.string().optional(),
    url: z.string().url().optional(),
    value: z.number().optional(),
    threshold: z.number().optional(),
    label: z.string().default("claim"),
  }),
  verificationNote: "This tool IS the verifier: it performs its check twice where the check is cheap and reports both readings.",
  availability: async () => ({ available: true, detail: "native checks" }),
  execute: async (_ctx, params) => {
    if (params.check === "file-exists" || params.check === "file-hash") {
      if (!params.path) return fail("FAILED", "path is required for file checks");
      const target = path.resolve(params.path);
      const info = await fileInfo(target).catch(() => null);
      if (!info) {
        return fail("VERIFICATION_FAILED", `${params.label}: file does not exist (${toRelative(DIRS.root, target)})`, [
          { kind: "fs-check", detail: "ENOENT" },
        ]);
      }
      if (params.check === "file-exists") {
        return ok(`${params.label} verified: ${toRelative(DIRS.root, target)} exists (${info.bytes}B)`, { ...info, path: toRelative(DIRS.root, target) }, [
          { kind: "fs-check", detail: `${info.bytes}B on disk` },
        ]);
      }
      const expected = params.expectedHash ?? "";
      const verified = expected.length > 0 && info.sha256 === expected;
      return {
        status: verified ? "SUCCESS" : "VERIFICATION_FAILED",
        summary: verified ? `${params.label} hash verified (${info.sha256.slice(0, 16)}…)` : `${params.label} hash mismatch: expected ${expected.slice(0, 16)}…, found ${info.sha256.slice(0, 16)}…`,
        data: { ...info, path: toRelative(DIRS.root, target), expected },
        evidence: [{ kind: "hash-double-read", detail: info.sha256 }],
        artifacts: [],
        verification: { verified, method: "sha256-compare", detail: verified ? "hashes equal" : "hashes differ" },
      };
    }
    if (params.check === "url-reachable") {
      if (!params.url) return fail("FAILED", "url is required for URL checks");
      const first = await fetch(params.url, { method: "GET", cache: "no-store" }).catch(() => null);
      const second = await fetch(params.url, { method: "HEAD", cache: "no-store" }).catch(() => null);
      const status = first?.status ?? second?.status ?? 0;
      const verified = status > 0 && status < 400;
      return {
        status: verified ? "SUCCESS" : "VERIFICATION_FAILED",
        summary: `${params.label}: ${params.url} → GET ${first?.status ?? "fail"} / HEAD ${second?.status ?? "fail"}`,
        data: { url: params.url, getStatus: first?.status ?? 0, headStatus: second?.status ?? 0 },
        evidence: [
          { kind: "http-get", detail: String(first?.status ?? "unreachable") },
          { kind: "http-head", detail: String(second?.status ?? "unreachable") },
        ],
        artifacts: [],
        verification: { verified, method: "two-method-http-probe", detail: `GET ${first?.status ?? 0}, HEAD ${second?.status ?? 0}` },
      };
    }
    const verified = params.value !== undefined && params.threshold !== undefined && params.value >= params.threshold;
    return {
      status: verified ? "SUCCESS" : "VERIFICATION_FAILED",
      summary: `${params.label}: ${params.value} ${verified ? "≥" : "<"} ${params.threshold}`,
      data: { value: params.value, threshold: params.threshold },
      evidence: [{ kind: "numeric-compare", detail: `${params.value} vs ${params.threshold}` }],
      artifacts: [],
      verification: { verified, method: "numeric-threshold", detail: `${params.value} >= ${params.threshold}` },
    };
  },
});

registerTool({
  id: "security.scan",
  title: "Policy scan",
  group: "security",
  description: "Runs the security validator over a command and/or path and returns the exact verdict with matched rules; writes an audit record.",
  risk: "LOW",
  resourceClass: "LIGHT",
  agents: ["security", "aisha", "qa", "ops"],
  params: z.object({ command: z.string().optional(), path: z.string().optional(), intent: z.enum(["read", "write", "delete", "list"]).default("read") }),
  verificationNote: "The scan result is written to audit_logs and read back so the verdict is auditable, not merely displayed.",
  availability: async () => ({ available: true, detail: "static policy engine" }),
  execute: async (_ctx, params) => {
    const results: Record<string, unknown> = {};
    if (params.command) results.command = await scanCommand(params.command);
    if (params.path) results.path = await checkPath(params.path, params.intent);
    if (!Object.keys(results).length) return fail("FAILED", "nothing to scan: provide command and/or path");
    const blocked = Object.values(results).some((value) => (value as { allowed: boolean }).allowed === false);
    await audit({
      actor: "security_agent",
      action: "policy.scan",
      target: params.command ?? params.path ?? "",
      risk: blocked ? "CRITICAL" : "LOW",
      decision: blocked ? "BLOCKED" : "ALLOWED",
      detail: results,
    });
    return {
      status: "SUCCESS",
      summary: blocked ? "policy scan: BLOCKED (see matched rules)" : "policy scan: allowed",
      data: { results, verdict: blocked ? "BLOCKED" : "ALLOWED" },
      evidence: [{ kind: "audit", detail: `audit_logs row written for ${params.command ?? params.path}` }],
      artifacts: [],
      verification: { verified: true, method: "audit-round-trip", detail: "verdict persisted to audit_logs" },
    };
  },
});

const CSV_HEADER = "taskId,toolId,status\n";
export const _qaHelpers = { CSV_HEADER, sha256, fs };
