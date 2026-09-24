/**
 * Security validator — strengthened Project 2 model.
 *
 *  * command validation: hard deny-list + optional explicit allowlist
 *  * workspace confinement: every path is resolved and checked against protected
 *    system roots and against the AISHA workspace/sandbox boundary
 *  * risk escalation: destructive/credential/permission operations are escalated
 *    to HIGH or CRITICAL, which forces a human approval
 *  * audit: every decision is written to audit_logs, allowed or blocked
 */
import path from "node:path";
import { db } from "@/db";
import { auditLogs, type RiskLevel } from "@/db/schema";
import { appConfig, DIRS, ALLOWED_COMMANDS, IS_WINDOWS } from "@/lib/config";
import { emit } from "@/lib/events";
import { redactSecrets } from "@/lib/util";

export type ScanResult = {
  allowed: boolean;
  risk: RiskLevel;
  reason: string;
  matched: string[];
};

const CRITICAL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bformat(\.com)?\b\s+[a-z]:/i, label: "drive format" },
  { re: /\bdiskpart\b/i, label: "disk partitioning" },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/i, label: "filesystem creation" },
  { re: /\bdd\b[^\n]*of=\/dev\/(sd|nvme|disk)/i, label: "raw device write" },
  { re: /remove-item\s+.*-recurse\s+.*-force\s+.*(c:\\(windows|users|program files)|[\\/]$)/i, label: "recursive system deletion" },
  { re: /\brm\s+-rf\s+\/(\s|$)/, label: "root recursive deletion" },
  { re: /disable-(windowsdefender|mpspreference)|set-mppreference\s+.*-disablerealtimemonitoring/i, label: "security disabling" },
  { re: /\bnet\s+user\b[^\n]*\/add\b/i, label: "account creation" },
  { re: /(reg\s+add|reg\s+delete|set-itemproperty\s+.*hk(lm|cu))/i, label: "registry tampering" },
  { re: /schtasks\s+\/create|new-scheduledtask|currentversion\\run/i, label: "persistence mechanism" },
  { re: /takeown|icacls\s+.*\/(grant|setowner)|set-acl/i, label: "ownership/ACL change" },
  { re: /mimikatz|lsass|secretsdump|procdump\s+.*lsass/i, label: "credential extraction" },
  { re: /bcdedit|vssadmin\s+delete\s+shadows/i, label: "boot/backup destruction" },
  { re: /\bnet\s+localgroup\s+administrators\b[^\n]*\/add/i, label: "privilege escalation" },
];

const HIGH_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /invoke-expression|iex\s+\(|downloadstring|iwr\s+.*\|\s*iex/i, label: "remote script execution" },
  { re: /\bdel(ete)?\b|\brm\b|remove-item|rmdir|shred|unlink/i, label: "deletion" },
  { re: /\b(shutdown|restart-computer|stop-computer)\b/i, label: "power control" },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-fdx?|push\s+--force)\b/i, label: "destructive git" },
  { re: /\bchmod\s+777|chown\s+root/i, label: "permission widening" },
  { re: /regedit|gpedit/i, label: "system editor" },
];

const NETWORK_RE = /\b(curl|wget|invoke-webrequest|iwr|irm|nc|ncat|ssh|scp)\b/i;

export async function loadProtectedPaths(): Promise<string[]> {
  const config = await appConfig();
  const fromEnv = (process.env.AISHA_PROTECTED_PATHS ?? "").split(/[;,]/).map((v) => v.trim()).filter(Boolean);
  return [...config.workspace.protectedPaths, ...fromEnv];
}

export async function checkPath(rawPath: string, intent: "read" | "write" | "delete" | "list"): Promise<ScanResult> {
  const resolved = path.resolve(rawPath);
  const protectedRoots = await loadProtectedPaths();
  const matched: string[] = [];
  const isWindowsStyle = /^[a-zA-Z]:[\\/]/.test(rawPath) || /^\\\\/.test(rawPath);
  for (const root of protectedRoots) {
    if (isWindowsStyle) {
      // A Windows path must be judged as a Windows path even when AISHA runs on
      // another host, otherwise "C:\Windows\..." would silently resolve to a
      // harmless-looking relative path.
      const comparable = rawPath.replace(/\//g, "\\").toLowerCase();
      const rootComparable = root.replace(/\//g, "\\").toLowerCase();
      if (comparable === rootComparable || comparable.startsWith(`${rootComparable}\\`)) matched.push(root);
      continue;
    }
    const normalizedRoot = path.resolve(root);
    if (resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
      matched.push(root);
    }
  }
  const containment = [DIRS.workspace, DIRS.artifacts, DIRS.runs, DIRS.uploads, DIRS.logs];
  const insideAisha = containment.some((dir) => resolved === dir || resolved.startsWith(`${dir}${path.sep}`));

  if (matched.length) {
    const risk: RiskLevel = intent === "read" ? "MEDIUM" : "CRITICAL";
    return {
      allowed: false,
      risk,
      reason: `path is inside a protected system location (${matched.join(", ")})`,
      matched,
    };
  }
  if (resolved.split(path.sep).filter(Boolean).length <= 1) {
    return { allowed: false, risk: "CRITICAL", reason: "refusing to operate on a filesystem root", matched: [resolved] };
  }
  if (intent === "delete") {
    return {
      allowed: insideAisha,
      risk: "HIGH",
      reason: insideAisha
        ? "deletion inside the AISHA workspace: allowed only with a signed approval"
        : "deletion outside the AISHA workspace/sandbox boundary is not permitted",
      matched: matched.length ? matched : [resolved],
    };
  }
  return { allowed: true, risk: insideAisha ? "LOW" : "MEDIUM", reason: insideAisha ? "inside AISHA workspace" : "outside workspace (sandbox read/write)", matched };
}

export async function scanCommand(command: string, program?: string): Promise<ScanResult> {
  const matched: string[] = [];
  for (const { re, label } of CRITICAL_PATTERNS) {
    if (re.test(command)) matched.push(`CRITICAL:${label}`);
  }
  if (matched.length) {
    return { allowed: false, risk: "CRITICAL", reason: `blocked by security policy (${matched.join(", ")})`, matched };
  }

  const highMatches: string[] = [];
  for (const { re, label } of HIGH_PATTERNS) {
    if (re.test(command)) highMatches.push(label);
  }
  const network = NETWORK_RE.test(command) ? ["network-egress"] : [];
  const listed = [...highMatches, ...network];

  const programName = (program ?? command.trim().split(/\s+/)[0] ?? "").replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
  if (ALLOWED_COMMANDS.length && programName && !ALLOWED_COMMANDS.includes(programName)) {
    return {
      allowed: true,
      risk: "HIGH",
      reason: `program "${programName}" is not on the explicit allowlist; widened scope requires approval`,
      matched: [...listed, "not-allowlisted"],
    };
  }
  if (listed.length) {
    return { allowed: true, risk: "HIGH", reason: `sensitive command pattern: ${listed.join(", ")}`, matched: listed };
  }
  return { allowed: true, risk: "MEDIUM", reason: "shell command passed the deny-list scan", matched: [] };
}

export function classifyIncoming(request: string): RiskLevel {
  const lower = request.toLowerCase();
  if (/(format the drive|wipe the disk|delete all|rm -rf \/|disable (defender|firewall)|registry|credential|password dump|scheduled task)/.test(lower)) {
    return "CRITICAL";
  }
  if (/(send (an )?email|email it|delete|remove file|uninstall|purchase|pay |transfer|publish|post to|shutdown|restart)/.test(lower)) {
    return "HIGH";
  }
  if (/(write|create|save|edit|modify|fill (the )?form|submit|click|type|open .*and|automate)/.test(lower)) {
    return "MEDIUM";
  }
  return "LOW";
}

export async function audit(input: {
  actor: string;
  action: string;
  target?: string;
  risk?: RiskLevel;
  decision: "ALLOWED" | "BLOCKED" | "PENDING" | "DENIED" | "GRANTED";
  detail?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditLogs).values({
    actor: input.actor,
    action: input.action,
    target: input.target ?? "",
    risk: input.risk ?? "LOW",
    decision: input.decision,
    detail: input.detail ?? {},
  });
  if (input.decision === "BLOCKED") {
    await emit({
      topic: "security.blocked",
      level: "warn",
      agentId: "security",
      message: redactSecrets(`blocked ${input.action} → ${input.target ?? ""} (${input.detail?.reason ?? "policy"})`),
      payload: { action: input.action, target: input.target, risk: input.risk, ...(input.detail ?? {}) },
    });
  } else {
    await emit({
      topic: "security.decision",
      agentId: "security",
      message: redactSecrets(`${input.decision}: ${input.action}${input.target ? ` → ${input.target}` : ""} [${input.risk ?? "LOW"}]`),
      payload: { action: input.action, target: input.target, decision: input.decision, risk: input.risk },
    });
  }
}

export const platformNote = IS_WINDOWS
  ? "Windows host detected: PowerShell, UI Automation and screen capture are the preferred execution paths."
  : `Non-Windows host (${process.platform}): Windows-only tools (UI Automation, mouse/keyboard, window control) report UNAVAILABLE instead of pretending.`;
