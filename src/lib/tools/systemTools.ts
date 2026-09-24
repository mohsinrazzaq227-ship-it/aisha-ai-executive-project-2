import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { db } from "@/db";
import { securityLog } from "@/db/schema";
import { runDoctor } from "@/lib/doctor";
import { logEvent } from "@/lib/logging";
import { validateShellCommand } from "@/lib/tools/registry";
import { ensureDir, humanSize, resolveUserPath } from "@/lib/workspace";
import { fail, ok, type ArtifactSpec, type ToolContext, type ToolHandler } from "@/lib/tools/types";

const execFileAsync = promisify(execFile);
const require_ = createRequire(`${process.cwd()}/package.json`);

function interpreterFor(shell: string | undefined): { bin: string; args: string[]; label: string } {
  const isWindows = process.platform === "win32";
  const requested = shell ?? (isWindows ? "powershell" : "bash");
  if (requested === "powershell" || requested === "cmd") {
    return { bin: isWindows ? "powershell.exe" : "pwsh", args: ["-NoProfile", "-NonInteractive", "-Command"], label: requested };
  }
  return { bin: "/bin/bash", args: ["-lc"], label: "bash" };
}

const shellPreview: ToolHandler = async (ctx) => {
  const command = String(ctx.input.command);
  const decision = validateShellCommand(command, ctx.allowedCommands);
  const interpreter = interpreterFor(ctx.input.shell as string | undefined);
  return {
    ok: decision.ok,
    summary: decision.ok
      ? `Command passed the validator. Program "${decision.program}" is allowed. Execution requires explicit approval.`
      : `Command REJECTED by the validator: ${decision.reason}`,
    agentMessage: decision.ok ? "The command passed validation. I need your approval before it runs." : "The command was rejected by the safety validator, so I will not run it.",
    output: {
      command,
      shell: interpreter.label,
      wouldRun: `${interpreter.bin} ${interpreter.args.join(" ")} ${decision.ok ? "" : ""}${command}`.trim(),
      validator: decision.ok ? "PASS" : "REJECT",
      reason: decision.reason ?? null,
      allowlist: ctx.allowedCommands,
      risk: "HIGH",
      requiresApproval: true,
    },
    error: decision.ok ? undefined : decision.reason,
  };
};

const shellExecute: ToolHandler = async (ctx) => {
  const command = String(ctx.input.command);
  // Defence in depth: the validator runs again at execution time, not only when approval was granted.
  const decision = validateShellCommand(command, ctx.allowedCommands);
  await db.insert(securityLog).values({
    event: decision.ok ? "shell.execute.allowed" : "shell.execute.blocked",
    toolId: "shell.execute",
    taskId: ctx.taskId,
    allowed: decision.ok,
    detail: decision.reason ?? `program ${decision.program}`,
    data: { command, stepId: ctx.stepId, agentId: ctx.agentId },
  });
  if (!decision.ok) {
    await logEvent("security", `Blocked shell execution: ${decision.reason}`, { level: "warn", taskId: ctx.taskId, agentId: ctx.agentId, data: { command } });
    return fail(`Execution blocked by the command validator: ${decision.reason}`, "VALIDATOR_BLOCKED", { command, decision });
  }

  const interpreter = interpreterFor(ctx.input.shell as string | undefined);
  const cwd = ctx.input.cwd ? resolveUserPath(String(ctx.input.cwd), "workspace") : ctx.workspace.projectRoot;
  ensureDir(cwd);
  const started = Date.now();
  const result = await new Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>((resolve) => {
    const child = spawn(interpreter.bin, [...interpreter.args, command], { cwd, timeout: 45000, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const onAbort = () => {
      killed = true;
      child.kill("SIGKILL");
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (data: Buffer) => {
      stdout = (stdout + data.toString()).slice(-100000);
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-100000);
    });
    child.on("error", (error) => {
      ctx.signal.removeEventListener("abort", onAbort);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}`, killed });
    });
    child.on("close", (code) => {
      ctx.signal.removeEventListener("abort", onAbort);
      resolve({ code: code ?? -1, stdout, stderr, killed });
    });
  });
  const durationMs = Date.now() - started;

  const executionDir = ensureDir(path.join(ctx.runDir, "logs"));
  const logPath = path.join(executionDir, `shell_${Date.now()}.json`);
  fs.writeFileSync(
    logPath,
    JSON.stringify(
      { command, shell: interpreter.label, cwd, exitCode: result.code, killed: result.killed, durationMs, stdout: result.stdout.slice(-20000), stderr: result.stderr.slice(-20000), approvedActionHash: ctx.findings.approvedParametersHash ?? null, timestamp: new Date().toISOString() },
      null,
      2,
    ),
    "utf8",
  );

  const suffix = result.killed ? " (terminated by cancellation or the 45s timeout)" : "";
  return {
    ok: result.code === 0,
    summary: `exit ${result.code} in ${durationMs} ms${suffix}. stdout: ${result.stdout.trim().slice(0, 400) || "(empty)"}${result.stderr.trim() ? ` | stderr: ${result.stderr.trim().slice(0, 300)}` : ""}`,
    error: result.code === 0 ? undefined : `Command exited with code ${result.code}${result.killed ? " after being terminated" : ""}`,
    agentMessage: result.code === 0 ? "Command executed successfully; the full audit record is stored with the task." : `The command exited with code ${result.code}.`,
    output: { command, shell: interpreter.label, cwd, exitCode: result.code, killed: result.killed, durationMs, stdout: result.stdout.slice(-20000), stderr: result.stderr.slice(-20000), auditPath: logPath },
    artifacts: [{ kind: "command-log", name: path.basename(logPath), absPath: logPath, mime: "application/json", meta: { command, exitCode: result.code, durationMs }, validated: true }],
  };
};

const hostInspect: ToolHandler = async (ctx) => {
  const r = ctx.workspace;
  const dirs = [r.dataRoot, r.runsRoot, r.uploadsRoot, r.outputRoot, r.logsRoot];
  const usage = dirs.map((dir) => {
    let bytes = 0;
    const walk = (current: string, depth = 0) => {
      if (depth > 4) return;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        try {
          if (entry.isDirectory()) walk(full, depth + 1);
          else bytes += fs.statSync(full).size;
        } catch {
          /* skip */
        }
      }
    };
    try {
      ensureDir(dir);
      walk(dir);
    } catch {
      /* ignore */
    }
    return { dir, size: humanSize(bytes), bytes };
  });

  let processes: string[] = [];
  if (ctx.input.detail === "processes") {
    try {
      const cmd = process.platform === "win32" ? "tasklist" : "ps";
      const args = process.platform === "win32" ? [] : ["-eo", "pid,comm,%cpu,%mem", "--sort=-%cpu"];
      const out = await execFileAsync(cmd, args, { timeout: 10000 });
      processes = out.stdout.split("\n").slice(0, 25);
    } catch (error) {
      processes = [`process inventory unavailable: ${(error as Error).message}`];
    }
  }

  let diskFree = "unknown";
  try {
    const stat = fs.statfsSync(r.projectRoot);
    diskFree = humanSize(stat.bavail * stat.bsize);
  } catch {
    /* not supported */
  }

  return ok(
    `Host: ${os.platform()} ${os.release()} ${os.arch()}, ${os.cpus().length} cores, ${humanSize(os.totalmem())} RAM, ${diskFree} free. Workspace roots verified.`,
    {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpus: os.cpus().length,
      totalMemory: humanSize(os.totalmem()),
      freeMemory: humanSize(os.freemem()),
      uptimeHours: Number((os.uptime() / 3600).toFixed(2)),
      diskFree,
      node: process.version,
      roots: r,
      storage: usage,
      processes,
      shellAvailable: process.platform === "win32" ? "powershell" : "bash",
    },
    `Host inspection complete. ${processes.length > 0 ? `${processes.length} processes sampled.` : ""}`,
  );
};

const doctorRun: ToolHandler = async (ctx) => {
  const report = await runDoctor(Boolean(ctx.input.deep ?? true));
  const dir = ensureDir(path.join(ctx.runDir, "validation"));
  const jsonPath = path.join(dir, "doctor_report.json");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  const failing = report.checks.filter((c) => c.status === "FAIL");
  return {
    ok: failing.length === 0,
    summary: `Doctor finished in ${report.durationMs} ms — ${report.summary.pass} PASS, ${report.summary.warning} WARNING, ${report.summary.fail} FAIL, ${report.summary.notConfigured} NOT_CONFIGURED, ${report.summary.clientSide} CLIENT_SIDE.${failing.length > 0 ? ` Failing: ${failing.map((f) => f.name).join(", ")}` : ""}`,
    error: failing.length > 0 ? failing.map((f) => `${f.name}: ${f.detail}`).join(" | ") : undefined,
    agentMessage: failing.length === 0 ? "All hard requirements pass; optional providers are reported honestly." : `${failing.length} hard check(s) failed, listed with actions in the report.`,
    output: report as unknown as Record<string, unknown>,
    artifacts: [{ kind: "diagnostics", name: "doctor_report.json", absPath: jsonPath, mime: "application/json", meta: report.summary as unknown as Record<string, unknown>, validated: true }],
  };
};

const visionInventory: ToolHandler = async (ctx) => {
  const isWindows = process.platform === "win32";
  const playwrightInstalled = (() => {
    try {
      require_.resolve("playwright");
      return true;
    } catch {
      return false;
    }
  })();
  const tesseract = (() => {
    try {
      const finder = isWindows ? "where" : "which";
      return require("node:child_process").execFileSync(finder, ["tesseract"], { timeout: 3000 }).toString().split("\n")[0].trim() || null;
    } catch {
      return null;
    }
  })();

  const hierarchy = [
    { level: "1. Windows accessibility tree (UI Automation)", available: isWindows, detail: isWindows ? "Available through the desktop host layer." : "Not available on this host OS." },
    { level: "2. DOM extraction (Playwright)", available: playwrightInstalled, detail: playwrightInstalled ? "Playwright installed — DOM queries take priority over pixels." : "Playwright not installed; the HTTP extraction engine is used instead." },
    { level: "3. OCR", available: Boolean(tesseract), detail: tesseract ? `Tesseract at ${tesseract}.` : "Tesseract not installed, so screenshot text cannot be read reliably." },
    { level: "4. Coordinate proposal (vision fallback)", available: false, detail: "Requires an actual screenshot from the desktop host layer. Without one, no coordinates are guessed." },
  ];

  const screenshots = ctx.input.uploadId ? null : null;
  let ocrResult: { text: string; path: string } | null = null;
  if (screenshots && tesseract) {
    try {
      const out = await execFileAsync(tesseract, [screenshots, "stdout"], { timeout: 30000 });
      ocrResult = { text: out.stdout.slice(0, 4000), path: screenshots };
    } catch {
      ocrResult = null;
    }
  }

  return {
    ok: hierarchy.some((h) => h.available),
    summary: `Screen inventory: ${hierarchy.filter((h) => h.available).length}/${hierarchy.length} structured sources available on ${os.platform()}. ${hierarchy.some((h) => h.available) ? "Structured data is preferred over pixel guessing, exactly as specified." : "No structured screen source is available here, so no action is proposed rather than clicking blindly."}`,
    agentMessage: hierarchy.some((h) => h.available)
      ? "Screen inventory complete using the mandated priority order: accessibility, then DOM, then OCR, then coordinates as a last resort."
      : "I cannot inspect the screen on this host, so I will not propose a click. Nothing is guessed.",
    output: { hierarchy, ocr: ocrResult, platform: os.platform(), target: ctx.input.target ?? null },
    error: hierarchy.some((h) => h.available) ? undefined : "No structured screen access available on this host",
  };
};

const emailList: ToolHandler = async (ctx) => {
  const configured = Boolean(process.env.IMAP_URL || process.env.GMAIL_REFRESH_TOKEN || process.env.MS_GRAPH_TOKEN);
  if (!configured) {
    return fail(
      "Inbox access is not configured, so I have no mail to show. Set IMAP_URL (or a Gmail/Microsoft token) to enable it. I will not invent messages.",
      "EMAIL_NOT_CONFIGURED",
      { required: ["IMAP_URL", "GMAIL_REFRESH_TOKEN", "MS_GRAPH_TOKEN"] },
    );
  }
  let imapflow: { IMAPFlow?: unknown } | null = null;
  try {
    imapflow = require_("imapflow") as { IMAPFlow?: unknown };
  } catch {
    return fail(
      "An IMAP endpoint is configured but the optional `imapflow` package is not installed, so no mailbox connection was attempted.",
      "EMAIL_DRIVER_MISSING",
      { install: "npm install imapflow" },
    );
  }
  try {
    const { IMAPFlow } = imapflow as unknown as { IMAPFlow: new (config: Record<string, unknown>) => {
      connect(): Promise<void>;
      mailboxOpen(name: string): Promise<unknown>;
      fetch(range: string, options: Record<string, unknown>): AsyncIterable<{ uid: number; envelope?: { subject?: string; from?: { address?: string }[]; date?: Date }; flags?: Set<string> }>;
      logout(): Promise<void>;
    } };
    const url = new URL(String(process.env.IMAP_URL));
    const client = new IMAPFlow({
      host: url.hostname,
      port: Number(url.port || 993),
      secure: true,
      auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) },
      logger: false,
    });
    await client.connect();
    const mailbox = await client.mailboxOpen("INBOX");
    const limit = Number(ctx.input.limit ?? 10);
    const messages: { uid: number; subject: string; from: string; date: string; unread: boolean }[] = [];
    for await (const message of client.fetch(`${Math.max(1, (mailbox as { exists?: number }).exists ?? 1 - limit + 1)}:*`, { envelope: true, flags: true })) {
      messages.push({
        uid: message.uid,
        subject: message.envelope?.subject ?? "(no subject)",
        from: message.envelope?.from?.[0]?.address ?? "unknown",
        date: message.envelope?.date?.toISOString() ?? "",
        unread: !(message.flags?.has("\\Seen") ?? false),
      });
      if (messages.length >= limit) break;
    }
    await client.logout();
    return ok(
      `Read ${messages.length} messages from the configured mailbox (${messages.filter((m) => m.unread).length} unread).`,
      { messages, query: ctx.input.query ?? null },
      `Inbox read: ${messages.length} messages, ${messages.filter((m) => m.unread).length} unread.`,
    );
  } catch (error) {
    return fail(`Mailbox connection failed: ${(error as Error).message}`, "EMAIL_CONNECTION_FAILED");
  }
};

const emailDraft: ToolHandler = async (ctx) => {
  const draftDir = ensureDir(path.join(ctx.runDir, "email"));
  const draftPath = path.join(draftDir, `draft_${Date.now()}.eml`);
  const body = String(ctx.input.body);
  const eml = [
    `To: ${String(ctx.input.to)}`,
    `Subject: ${String(ctx.input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    `Date: ${new Date().toUTCString()}`,
    ctx.input.inReplyTo ? `In-Reply-To: ${String(ctx.input.inReplyTo)}` : "",
    "",
    body,
    "",
  ]
    .filter((line) => line !== "")
    .join("\r\n");
  fs.writeFileSync(draftPath, eml, "utf8");
  return {
    ok: true,
    summary: `Draft written to ${draftPath} (${humanSize(Buffer.byteLength(eml))}). Nothing was sent.`,
    agentMessage: "The draft is written as a real .eml file for your review. Nothing left this machine.",
    output: { draftPath, to: ctx.input.to, subject: ctx.input.subject, sent: false, bytes: Buffer.byteLength(eml) },
    artifacts: [{ kind: "email-draft", name: path.basename(draftPath), absPath: draftPath, mime: "message/rfc822", meta: { to: ctx.input.to, subject: ctx.input.subject } }],
  };
};

const emailSend: ToolHandler = async (ctx) => {
  if (!process.env.SMTP_URL) {
    return fail(
      "Sending is not configured (SMTP_URL missing), so no message was transmitted. I will not claim an email was sent.",
      "EMAIL_NOT_CONFIGURED",
      { required: ["SMTP_URL"] },
    );
  }
  let nodemailer: { createTransport?: unknown } | null = null;
  try {
    nodemailer = require_("nodemailer") as { createTransport?: unknown };
  } catch {
    return fail("SMTP_URL is configured but the optional `nodemailer` package is not installed, so no transmission was attempted.", "EMAIL_DRIVER_MISSING", { install: "npm install nodemailer" });
  }
  try {
    const { createTransport } = nodemailer as unknown as { createTransport: (url: string) => { sendMail: (options: Record<string, unknown>) => Promise<{ messageId?: string; response?: string }> } };
    const transport = createTransport(String(process.env.SMTP_URL));
    const attachments = ((ctx.input.attachmentIds as string[] | undefined) ?? [])
      .map((artifactId) => (ctx.findings.artifactPaths as Record<string, string> | undefined)?.[artifactId])
      .filter((p): p is string => Boolean(p && fs.existsSync(p)))
      .map((p) => ({ filename: path.basename(p), path: p }));
    const info = await transport.sendMail({
      from: process.env.SMTP_FROM ?? process.env.SMTP_URL,
      to: String(ctx.input.to),
      subject: String(ctx.input.subject),
      text: String(ctx.input.body),
      attachments,
    });
    await logEvent("security", `Email sent to ${String(ctx.input.to)}`, { level: "warn", taskId: ctx.taskId, agentId: ctx.agentId, data: { messageId: info.messageId } });
    return ok(
      `Email accepted by the SMTP server: ${info.response ?? info.messageId ?? "accepted"} (${attachments.length} attachment(s)).`,
      { messageId: info.messageId, response: info.response, attachments: attachments.length, sent: true },
      "The message was accepted by your mail server. This action is recorded in the audit log.",
    );
  } catch (error) {
    return fail(`SMTP transmission failed: ${(error as Error).message}`, "SMTP_FAILED");
  }
};

const capabilitiesProbe: ToolHandler = async (ctx) => {
  const { probeCapabilities, capabilityMatrix } = await import("@/lib/capabilities");
  const capabilities = await probeCapabilities({ deep: Boolean(ctx.input.deep ?? true) });
  const matrix = capabilityMatrix(capabilities);
  const dir = ensureDir(path.join(ctx.runDir, "validation"));
  const jsonPath = path.join(dir, "capabilities.json");
  const mdPath = path.join(dir, "capabilities.md");
  fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), matrix, capabilities }, null, 2), "utf8");
  fs.writeFileSync(
    mdPath,
    ["# Capability matrix (functional probes)", "", `Generated ${new Date().toISOString()}`, "", "| Capability | Status | Evidence |", "|---|---|---|", ...capabilities.map((c) => `| ${c.label} | **${c.status}** | ${c.evidence.replace(/\|/g, "/")} |`)].join("\n"),
    "utf8",
  );
  const broken = capabilities.filter((c) => c.status === "FAILED");
  return {
    ok: broken.length === 0,
    summary: `Capability probe finished: ${matrix.available} AVAILABLE, ${matrix.degraded} DEGRADED, ${matrix.notConfigured} NOT_CONFIGURED, ${matrix.unavailable} UNAVAILABLE, ${matrix.notVerified} NOT_VERIFIED, ${matrix.clientSide} CLIENT_SIDE, ${matrix.failed} FAILED.${broken.length > 0 ? ` Broken: ${broken.map((c) => c.label).join(", ")}` : ""}`,
    error: broken.length > 0 ? broken.map((c) => `${c.label}: ${c.detail}`).join(" | ") : undefined,
    agentMessage:
      broken.length === 0
        ? `Capability probe complete. ${matrix.available} capabilities passed functional checks; ${matrix.notConfigured + matrix.unavailable + matrix.notVerified} are honestly reported as not available in this environment.`
        : `${broken.length} capability probe(s) failed and are reported as broken rather than silently ignored.`,
    output: { matrix, capabilities: capabilities.map((c) => ({ id: c.id, label: c.label, status: c.status, detail: c.detail, evidence: c.evidence })) } as unknown as Record<string, unknown>,
    artifacts: [
      { kind: "capabilities", name: "capabilities.json", absPath: jsonPath, mime: "application/json", meta: matrix as unknown as Record<string, unknown>, validated: true },
      { kind: "capabilities", name: "capabilities.md", absPath: mdPath, mime: "text/markdown" },
    ],
  };
};

export const SYSTEM_TOOLS: Record<string, ToolHandler> = {
  "shell.preview": shellPreview,
  "shell.execute": shellExecute,
  "host.inspect": hostInspect,
  "doctor.run": doctorRun,
  "vision.inventory": visionInventory,
  "email.list": emailList,
  "email.draft": emailDraft,
  "email.send": emailSend,
  "capabilities.probe": capabilitiesProbe,
};
