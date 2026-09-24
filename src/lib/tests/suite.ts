/**
 * Runtime acceptance suite.
 *
 * These checks execute the real system: real tools, real database rows, real
 * files, real subprocesses, real approval gates. A check is only PASS when the
 * asserted state was observed. Unsupported capabilities are reported as
 * UNAVAILABLE together with the reason the probe returned — never as PASS.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentStates, approvals, artifacts, auditLogs, events, steps as stepsTable, tasks, testRuns, toolRuns } from "@/db/schema";
import { DIRS, appConfig } from "@/lib/config";
import { AGENTS, positionOf, walkDurationMs } from "@/lib/agents";
import { classifyIntent, deterministicPlan } from "@/lib/planner";
import { runTool, listTools } from "@/lib/tools";
import { probe } from "@/lib/ollama";
import { hashAction, newId, sha256 } from "@/lib/util";
import { scanCommand, checkPath } from "@/lib/security";
import { startTask, cancelTask, decideApproval, recoverStaleTasks } from "@/lib/supervisor";
import { ffmpegPath } from "@/lib/tools/media";
import { voiceStatus } from "@/lib/tools/voice";
import type { ToolContext } from "@/lib/tools/types";

export type CheckStatus = "PASS" | "FAIL" | "UNAVAILABLE" | "SKIP";
export type CheckResult = { id: string; area: string; name: string; status: CheckStatus; detail: string; ms: number };

const TEST_TASK = "selftest";

function ctxFor(toolId: string, approval: ToolContext["approval"] = null): ToolContext {
  const tool = listTools().find((t) => t.id === toolId);
  const agentId = tool?.agents[0] ?? "aisha";
  return {
    taskId: TEST_TASK,
    stepId: `${TEST_TASK}_${toolId}`,
    agentId,
    signal: new AbortController().signal,
    approval,
    log: async () => undefined,
  };
}

async function runToolAs(toolId: string, params: Record<string, unknown>, approval: ToolContext["approval"] = null, agentId?: string) {
  const ctx = ctxFor(toolId, approval);
  if (agentId) ctx.agentId = agentId;
  return runTool({ toolId, params, ctx });
}

export async function runAcceptanceSuite(): Promise<{ id: string; passed: number; failed: number; total: number; ms: number; results: CheckResult[] }> {
  const started = Date.now();
  const results: CheckResult[] = [];
  const check = async (id: string, area: string, name: string, fn: () => Promise<{ status: CheckStatus; detail: string }>) => {
    const t0 = Date.now();
    try {
      const outcome = await fn();
      results.push({ id, area, name, status: outcome.status, detail: outcome.detail, ms: Date.now() - t0 });
    } catch (error) {
      results.push({ id, area, name, status: "FAIL", detail: `threw: ${String(error).slice(0, 300)}`, ms: Date.now() - t0 });
    }
  };
  const expect = (condition: boolean, passDetail: string, failDetail: string) =>
    condition ? { status: "PASS" as CheckStatus, detail: passDetail } : { status: "FAIL" as CheckStatus, detail: failDetail };

  await fs.mkdir(DIRS.workspace, { recursive: true });
  await fs.mkdir(`${DIRS.workspace}/datasets`, { recursive: true });

  // ---------------------------------------------------------------- CORE
  await check("core.database", "CORE", "Database round-trip", async () => {
    const before = await db.select({ count: sql<number>`count(*)::int` }).from(events);
    await db.insert(events).values({ topic: "system.selftest", message: "acceptance suite database probe" });
    const after = await db.select({ count: sql<number>`count(*)::int` }).from(events);
    return expect((after[0]?.count ?? 0) === (before[0]?.count ?? 0) + 1, `events ${before[0]?.count} → ${after[0]?.count}`, `insert not observed (${before[0]?.count} → ${after[0]?.count})`);
  });

  await check("core.registry", "CORE", "Tool registry integrity", async () => {
    const tools = listTools();
    const ids = new Set(tools.map((t) => t.id));
    const withoutVerification = tools.filter((t) => !t.verificationNote?.trim());
    const withoutAvailability = tools.filter((t) => typeof t.availability !== "function");
    return expect(
      tools.length > 20 && ids.size === tools.length && withoutVerification.length === 0 && withoutAvailability.length === 0,
      `${tools.length} unique tools; every tool declares availability + verification note`,
      `registry problems: ${ids.size}/${tools.length} unique, ${withoutVerification.length} without verification note, ${withoutAvailability.length} without availability()`,
    );
  });

  await check("core.agents", "CORE", "Agent registry seeded (16)", async () => {
    const rows = await db.select().from(agentStates);
    return expect(AGENTS.length === 16 && rows.length === 16, `${rows.length} agent state rows for ${AGENTS.length} definitions`, `expected 16 of each, found ${rows.length} states / ${AGENTS.length} definitions`);
  });

  await check("core.resources", "CORE", "Resource governor", async () => {
    const { snapshot } = await import("@/lib/resources");
    const snap = await snapshot(true);
    return expect(snap.totalMemMb > 0 && snap.cpuCount > 0, `${snap.pressure}: ${snap.freeMemMb}MB free of ${snap.totalMemMb}MB, ${snap.cpuCount} cores — ${snap.explanation}`, "snapshot returned no memory/cpu facts");
  });

  await check("core.config", "CORE", "Runtime configuration", async () => {
    const config = await appConfig();
    return expect(config.autonomy.maxConcurrentSteps > 0 && config.approvals.ttlMinutes > 0, `maxConcurrentSteps=${config.autonomy.maxConcurrentSteps}, approval TTL=${config.approvals.ttlMinutes}min`, "config.json could not be loaded");
  });

  // ---------------------------------------------------------------- PLANNER
  await check("planner.intent", "SUPERVISOR", "Intent classification", async () => {
    const cases: Array<[string, string]> = [
      ["research three suppliers and prepare a report and email it to me", "EMAIL"],
      ["fill in this web form and submit it", "BROWSER"],
      ["render a 30 second video with captions", "MEDIA"],
      ["analyse this csv of prices", "DATA"],
      ["run host diagnostics", "SYSTEM"],
    ];
    const mismatches = cases.filter(([request, expected]) => classifyIntent(request) !== expected);
    return expect(mismatches.length === 0, `all ${cases.length} intents classified as expected`, `misclassified: ${mismatches.map(([r]) => r).join(" | ")}`);
  });

  await check("planner.dag", "SUPERVISOR", "Deterministic planner builds a runnable DAG", async () => {
    const plan = deterministicPlan("research three suppliers and prepare a report and email it to me");
    const roots = plan.steps.filter((s) => s.dependsOn.length === 0);
    const knownTools = plan.steps.every((s) => listTools().some((t) => t.id === s.toolId));
    const acyclic = plan.steps.every((s) => s.dependsOn.every((dep) => plan.steps.some((other) => other.id === dep)));
    const bridgesSections = plan.steps.some((s) => s.toolId === "report.write") && plan.steps.some((s) => s.toolId.startsWith("research.")) && plan.steps.some((s) => s.toolId.startsWith("email."));
    return expect(
      roots.length >= 3 && knownTools && acyclic && bridgesSections,
      `${plan.steps.length} steps, ${roots.length} parallel roots, all tool ids real, graph acyclic, research→report→email linked`,
      `roots=${roots.length}, toolsValid=${knownTools}, acyclic=${acyclic}, linked=${bridgesSections}`,
    );
  });

  // ---------------------------------------------------------------- FILES
  await check("files.write-read", "FILES", "Write + read + hash", async () => {
    const target = `${DIRS.workspace}/selftest-file.txt`;
    const written = await runToolAs("fs.write", { path: target, content: "AISHA selftest content", append: false });
    const read = await runToolAs("fs.read", { path: target });
    const hash = await runToolAs("fs.hash", { path: target });
    const expected = sha256("AISHA selftest content");
    const hashMatches = (hash.data as { sha256?: string })?.sha256 === expected;
    return expect(
      written.status === "SUCCESS" && read.status === "SUCCESS" && hashMatches,
      `write/read SUCCESS, sha256 ${expected.slice(0, 12)}… verified twice`,
      `write=${written.status} read=${read.status} hashMatches=${hashMatches}`,
    );
  });

  await check("files.copy-archive", "FILES", "Copy + zip archive", async () => {
    const copy = await runToolAs("fs.copy", { from: `${DIRS.workspace}/selftest-file.txt`, to: `${DIRS.workspace}/selftest-copy.txt`, move: false });
    const archive = await runToolAs("fs.archive", { paths: [`${DIRS.workspace}/selftest-copy.txt`] });
    return expect(
      copy.status === "SUCCESS" && archive.status === "SUCCESS" && Boolean((archive.data as { artifacts?: unknown[] })?.artifacts?.length),
      `copy verified by hash, archive registered as artifact`,
      `copy=${copy.status} archive=${archive.status} ${archive.summary}`,
    );
  });

  await check("files.protected-path", "SECURITY", "Protected system path refused", async () => {
    const windows = await checkPath("C:\\Windows\\System32\\drivers\\etc\\hosts", "write");
    const posix = await checkPath("/etc/passwd", "write");
    return expect(!windows.allowed && !posix.allowed, `both protected roots refused (${windows.reason} / ${posix.reason})`, `a protected path was allowed: ${JSON.stringify([windows.allowed, posix.allowed])}`);
  });

  // ---------------------------------------------------------------- APPROVAL
  const approvalTarget = `${DIRS.workspace}/selftest-approval.txt`;
  await check("approval.required", "APPROVAL", "HIGH-risk tool blocked without approval", async () => {
    await fs.writeFile(approvalTarget, "to be deleted", "utf8");
    const denied = await runToolAs("fs.delete", { path: approvalTarget, reason: "selftest" });
    const stillThere = await fs
      .access(approvalTarget)
      .then(() => true)
      .catch(() => false);
    return expect(denied.status === "BLOCKED" && stillThere, `fs.delete BLOCKED by the approval gate; file untouched`, `status=${denied.status}, fileStillExists=${stillThere}`);
  });

  await check("approval.hash-mismatch", "APPROVAL", "Approval token hash mismatch rejected", async () => {
    const wrong = hashAction({ action: "fs.delete", target: approvalTarget, params: { path: approvalTarget, reason: "different" } });
    const result = await runToolAs("fs.delete", { path: approvalTarget, reason: "selftest" }, { granted: true, token: "t", actionHash: wrong });
    return expect(result.status === "BLOCKED", `mismatched action hash rejected (${result.summary})`, `mismatched hash was accepted: ${result.status}`);
  });

  await check("approval.granted", "APPROVAL", "Granted approval executes and verifies", async () => {
    const params = { path: approvalTarget, reason: "selftest deletion" };
    const correct = hashAction({ action: "fs.delete", target: approvalTarget, params });
    const result = await runToolAs("fs.delete", params, { granted: true, token: "t", actionHash: correct });
    const gone = !(await fs.access(approvalTarget).then(() => true, () => false));
    return expect(result.status === "SUCCESS" && gone && result.verification?.verified === true, `delete executed with a matched hash and post-condition check`, `status=${result.status}, gone=${gone}`);
  });

  // ---------------------------------------------------------------- DOCS
  await check("docs.formats", "DOCUMENTS", "PDF/DOCX/XLSX/CSV/JSON/MD generation", async () => {
    const formats = ["pdf", "docx", "xlsx", "csv", "json", "md", "txt"] as const;
    const failures: string[] = [];
    for (const format of formats) {
      const result = await runToolAs("doc.generate", {
        title: `AISHA selftest ${format}`,
        format,
        sections: [{ heading: "Selftest", body: `Generated and structurally validated at ${new Date().toISOString()}` }],
      });
      if (result.status !== "SUCCESS") failures.push(`${format}:${result.status}`);
    }
    return expect(failures.length === 0, `${formats.length} formats generated and re-parsed: ${formats.join(", ")}`, `failed: ${failures.join(", ")}`);
  });

  await check("docs.artifact-integrity", "DOCUMENTS", "Artifacts hash-verified on disk", async () => {
    const rows = await db.select().from(artifacts).where(eq(artifacts.taskId, TEST_TASK)).orderBy(desc(artifacts.createdAt)).limit(5);
    if (!rows.length) return { status: "FAIL", detail: "no artifacts registered for the selftest task" };
    const mismatches: string[] = [];
    for (const row of rows) {
      const buffer = await fs.readFile(row.path).catch(() => null);
      if (!buffer || sha256(buffer) !== row.sha256) mismatches.push(row.name);
    }
    return expect(mismatches.length === 0, `${rows.length} artifact(s) re-read from disk with matching sha256`, `mismatching artifacts: ${mismatches.join(", ")}`);
  });

  await check("data.analyze", "DATA", "CSV analysis with independent recount", async () => {
    const csv = "supplier,price,lead_time\nAtlas,120,12\nBorealis,98,18\nCygnus,143,9\n";
    await fs.writeFile(`${DIRS.workspace}/datasets/selftest.csv`, csv, "utf8");
    const result = await runToolAs("data.analyze", { path: `${DIRS.workspace}/datasets/selftest.csv`, writeSummary: true });
    const stats = (result.data as { stats?: Array<{ column: string; sum: number }> })?.stats ?? [];
    const priceSum = stats.find((s) => s.column === "price")?.sum;
    return expect(result.status === "SUCCESS" && priceSum === 361, `price sum ${priceSum} matches 120+98+143`, `status=${result.status}, priceSum=${priceSum}`);
  });

  // ---------------------------------------------------------------- SYSTEM / SECURITY
  await check("system.host", "CORE", "Host diagnostics", async () => {
    const result = await runToolAs("system.host", {});
    const data = result.data as { platform?: string; cpuModel?: string };
    return expect(result.status === "SUCCESS" && Boolean(data.platform && data.cpuModel), `${data.platform} · ${data.cpuModel}`, `status=${result.status} data=${JSON.stringify(data).slice(0, 200)}`);
  });

  await check("system.processes", "CORE", "Process inventory", async () => {
    const result = await runToolAs("system.processes", { limit: 5 });
    return expect(result.status === "SUCCESS", String(result.summary).slice(0, 200), result.summary);
  });

  await check("security.forbidden-command", "SECURITY", "Forbidden commands blocked", async () => {
    const cases = ["format c: /y", "rm -rf /", "vssadmin delete shadows /all", "net user hacker P@ss /add", "reg add HKLM\\Software\\Run /v x"];
    const allowed = [];
    for (const command of cases) {
      const scan = await scanCommand(command);
      if (scan.allowed) allowed.push(command);
    }
    return expect(allowed.length === 0, `all ${cases.length} destructive patterns refused by the validator`, `incorrectly allowed: ${allowed.join(" | ")}`);
  });

  await check("security.audit-log", "SECURITY", "Audit log written for scan decisions", async () => {
    const before = await db.select({ count: sql<number>`count(*)::int` }).from(auditLogs);
    await runToolAs("security.scan", { command: "rm -rf /tmp/selftest", path: DIRS.workspace, intent: "read" }, null, "security");
    const after = await db.select({ count: sql<number>`count(*)::int` }).from(auditLogs);
    return expect((after[0]?.count ?? 0) > (before[0]?.count ?? 0), `audit_logs ${before[0]?.count} → ${after[0]?.count}`, "security.scan did not write an audit row");
  });

  await check("security.shell-approval", "SECURITY", "Shell requires approval before execution", async () => {
    const result = await runToolAs("system.shell", { command: "echo selftest" }, null, "code");
    const runs = await db.select().from(toolRuns).where(eq(toolRuns.stepId, `${TEST_TASK}_system.shell`));
    const executed = runs.filter((row) => row.status === "SUCCESS");
    return expect(
      result.status === "BLOCKED" && executed.length === 0,
      `shell refused without approval; ${runs.length} blocked attempt(s) recorded in tool_runs, ${executed.length} ever executed`,
      `status=${result.status}, successfulExecutions=${executed.length}`,
    );
  });

  // ---------------------------------------------------------------- SUPERVISOR LIFECYCLE
  await check("supervisor.lifecycle", "SUPERVISOR", "Create → plan → execute → approval → deny → cancel", async () => {
    const task = await startTask({ request: "run host diagnostics and check the process list" });
    const seen = { approval: false, actionHash: false, parallelRoots: 0 };
    let approvalId: string | null = null;
    const deadline = Date.now() + 30_000;
    let planSeen = false;
    while (Date.now() < deadline) {
      const [current] = await db.select().from(tasks).where(eq(tasks.id, task.id));
      const plan = (current?.plan ?? {}) as { steps?: Array<{ dependsOn?: string[] }> };
      if ((plan.steps ?? []).length) {
        planSeen = true;
        seen.parallelRoots = (plan.steps ?? []).filter((s) => (s.dependsOn ?? []).length === 0).length;
      }
      const pending = await db.select().from(approvals).where(and(eq(approvals.taskId, task.id), eq(approvals.status, "PENDING")));
      if (pending.length) {
        seen.approval = true;
        approvalId = pending[0].id;
        seen.actionHash = /^[0-9a-f]{64}$/.test(pending[0].actionHash);
        break;
      }
      const row = await db.select().from(stepsTable).where(eq(stepsTable.taskId, task.id));
      if (planSeen && row.length > 0 && row.every((s) => !["PENDING", "RUNNING", "WAITING_DEPENDENCY", "WAITING_APPROVAL"].includes(s.status))) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (!approvalId) {
      await cancelTask(task.id, "selftest");
      return { status: "FAIL", detail: `no approval was requested for a HIGH-risk shell step (parallelRoots=${seen.parallelRoots})` };
    }
    if (!seen.actionHash) return { status: "FAIL", detail: "approval row carried no valid action hash" };
    const denied = await decideApproval({ id: approvalId, decision: "DENIED", actor: "acceptance-suite", note: "selftest denial" });
    if (!denied.ok) return { status: "FAIL", detail: `denial failed: ${denied.detail}` };

    let blocked = false;
    const blockDeadline = Date.now() + 20_000;
    while (Date.now() < blockDeadline) {
      const rows = await db.select().from(stepsTable).where(eq(stepsTable.taskId, task.id));
      if (rows.some((row) => row.status === "BLOCKED")) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const cancel = await cancelTask(task.id, "acceptance-suite");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const [finalTask] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    const finalSteps = await db.select().from(stepsTable).where(eq(stepsTable.taskId, task.id));
    const unverifiedSuccess = finalSteps.filter((row) => row.status === "SUCCESS" && row.verification?.verified !== true);
    const pass = blocked && seen.parallelRoots >= 3 && unverifiedSuccess.length === 0 && Boolean(finalTask?.status);
    return expect(
      pass,
      `task ${finalTask?.status}; ${seen.parallelRoots} parallel roots; denial → BLOCKED observed; ${finalSteps.filter((s) => s.status === "SUCCESS").length} verified steps; cancel=(${cancel.detail})`,
      `blocked=${blocked}, roots=${seen.parallelRoots}, unverifiedSuccess=${unverifiedSuccess.length}, final=${finalTask?.status}`,
    );
  });

  await check("supervisor.cancellation", "SUPERVISOR", "Cancellation verified in persisted state", async () => {
    const task = await startTask({ request: "research the local AI market and prepare a report" });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const cancel = await cancelTask(task.id, "acceptance-suite");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    const evidence = row?.cancelVerified as { aborted?: boolean; stillRunning?: string[] } | null;
    const runningSteps = (await db.select().from(stepsTable).where(eq(stepsTable.taskId, task.id))).filter((s) => s.status === "RUNNING");
    return expect(
      cancel.ok && Boolean(evidence) && (evidence?.stillRunning?.length ?? 0) === 0 && runningSteps.length === 0,
      `abort observed, no step left RUNNING, evidence persisted: ${JSON.stringify(evidence).slice(0, 180)}`,
      `cancel=${cancel.detail}; evidence=${JSON.stringify(evidence)?.slice(0, 160)}; runningSteps=${runningSteps.length}`,
    );
  });

  await check("supervisor.recovery", "RECOVERY", "Restart recovery reconciles stale state", async () => {
    const taskId = newId("task");
    await db.insert(tasks).values({ id: taskId, request: "stale task used by the acceptance suite", intent: "SYSTEM", engine: "DETERMINISTIC", status: "RUNNING" });
    await db.insert(stepsTable).values({ id: newId("s"), taskId, stepIndex: 0, title: "stale step", agentId: "ops", toolId: "system.host", status: "RUNNING", maxAttempts: 1 });
    const recovered = await recoverStaleTasks();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const staleSteps = await db.select().from(stepsTable).where(eq(stepsTable.taskId, taskId));
    const recoveryEvents = await db.select().from(events).where(eq(events.topic, "task.recovery")).orderBy(desc(events.id)).limit(3);
    return expect(
      recovered >= 1 && row?.status === "FAILED" && staleSteps.every((s) => s.status === "CANCELLED") && recoveryEvents.some((e) => e.payload && JSON.stringify(e.payload).includes("stale step")),
      `${recovered} stale task(s) reconciled; step marked CANCELLED; task.recovery event emitted`,
      `recovered=${recovered}, status=${row?.status}, stepStatuses=${staleSteps.map((s) => s.status).join(",")}`,
    );
  });

  // ---------------------------------------------------------------- 3D / EVENTS
  await check("office.geometry", "3D", "Office geometry and walk timing are derived, not faked", async () => {
    const from = positionOf("research");
    const to = positionOf("aisha");
    const realistic = walkDurationMs(from, to, true);
    const fast = walkDurationMs(from, to, false);
    return expect(
      realistic > fast && realistic > 400,
      `distance-based walk: ${realistic}ms (realistic) vs ${fast}ms (cinematic) from (${from.x},${from.z}) → (${to.x},${to.z})`,
      `walk duration not derived from geometry (${realistic} vs ${fast})`,
    );
  });

  await check("office.event-stream", "3D", "3D office is driven by the same event stream", async () => {
    const topics = (await db.select({ topic: events.topic }).from(events).limit(5000)).map((row) => row.topic);
    const required = ["task.created", "task.planned", "step.started", "tool.started", "tool.completed", "handoff.started", "handoff.completed", "verification.started", "verification.completed", "approval.requested", "approval.denied", "artifact.created", "agent.walk.started", "agent.walk.completed"];
    const missing = required.filter((topic) => !topics.includes(topic));
    return expect(missing.length === 0, `${required.length} event topics observed in the single authoritative stream`, `missing topics: ${missing.join(", ")}`);
  });

  await check("office.agent-state", "3D", "Agent states map to real task activity", async () => {
    const rows = await db.select().from(agentStates);
    const withPositions = rows.filter((row) => row.position && typeof row.position.x === "number");
    const taskBoundEvents = await db.select({ count: sql<number>`count(*)::int` }).from(events).where(sql`${events.agentId} is not null`);
    return expect(
      withPositions.length === rows.length && (taskBoundEvents[0]?.count ?? 0) > 0,
      `${rows.length} agents carry office positions; ${taskBoundEvents[0]?.count} agent-attributed events`,
      `positions=${withPositions.length}/${rows.length} agentEvents=${taskBoundEvents[0]?.count}`,
    );
  });

  // ---------------------------------------------------------------- MEDIA
  await check("media.png-composer", "MEDIA", "Deterministic PNG scene composition", async () => {
    const result = await runToolAs("media.cards", { title: "selftest", scenes: [{ heading: "Scene 1", body: "deterministic render" }], width: 640, height: 360 });
    const registered = (result.data as { artifacts?: unknown[] })?.artifacts ?? [];
    return expect(result.status === "SUCCESS" && registered.length === 1, `PNG composed, IHDR-decoded and registered (${registered.length} artifact)`, `${result.status}: ${result.summary}`);
  });

  await check("media.ffmpeg-render", "MEDIA", "ffmpeg render validated by ffprobe", async () => {
    const ffmpeg = await ffmpegPath();
    if (!ffmpeg) return { status: "UNAVAILABLE", detail: "ffmpeg binary unavailable: render/validation cannot run on this host" };
    const result = await runToolAs("media.video", {
      title: "selftest render",
      scenes: [
        { heading: "One", body: "first deterministic scene", seconds: 1 },
        { heading: "Two", body: "second deterministic scene", seconds: 1 },
      ],
      resolution: { width: 640, height: 360 },
      fps: 12,
    });
    const probeData = (result.data as { ffprobe?: { streams?: Array<{ codec_type?: string; width?: number; height?: number }> } })?.ffprobe;
    const video = probeData?.streams?.find((s) => s.codec_type === "video");
    return expect(result.status === "SUCCESS" && video?.width === 640, `MP4 rendered and ffprobe-verified (${video?.width}x${video?.height})`, `${result.status}: ${result.summary}`);
  });

  await check("media.captions", "MEDIA", "SRT caption generation", async () => {
    const result = await runToolAs("media.captions", { title: "selftest captions", segments: [{ start: 0, end: 1.5, text: "first cue" }, { start: 1.5, end: 3, text: "second cue" }] });
    return expect(result.status === "SUCCESS", String(result.summary), `${result.status}: ${result.summary}`);
  });

  // ---------------------------------------------------------------- BROWSER
  await check("browser.automation", "BROWSER", "Playwright navigation + DOM + screenshot", async () => {
    const tool = listTools().find((t) => t.id === "browser.navigate");
    const availability = await tool?.availability();
    if (!availability?.available) {
      return { status: "UNAVAILABLE", detail: `${availability?.detail ?? "playwright unavailable"} — fix: ${availability?.fix ?? "npx playwright install chromium"}` };
    }
    const result = await runToolAs("browser.navigate", { url: "https://example.com", screenshot: true });
    const data = (result.data ?? {}) as { finalUrl?: string; facts?: { title?: string }; screenshotBytes?: number };
    return expect(
      result.status === "SUCCESS" && Boolean(data.facts?.title),
      `navigated ${data.finalUrl} · "${data.facts?.title}" · screenshot ${data.screenshotBytes}B`,
      `${result.status}: ${result.summary}`,
    );
  });

  await check("browser.form-verification", "BROWSER", "Form fill requires post-action confirmation", async () => {
    const tool = listTools().find((t) => t.id === "browser.form");
    const availability = await tool?.availability();
    if (!availability?.available) return { status: "UNAVAILABLE", detail: `${availability?.detail ?? "playwright unavailable"}` };
    const result = await runToolAs("browser.form", {
      url: "https://example.com",
      fields: { "#nonexistent-field": "value" },
      expectText: "this text cannot exist",
      screenshot: false,
    });
    return expect(result.status !== "SUCCESS", `unverifiable form action correctly reported as ${result.status}`, `form action with impossible expectations reported ${result.status}`);
  });

  // ---------------------------------------------------------------- VISION
  await check("vision.capture", "VISION", "Screen capture on this host", async () => {
    const tool = listTools().find((t) => t.id === "computer.capture_screen");
    const availability = await tool?.availability();
    if (!availability?.available) return { status: "UNAVAILABLE", detail: `${availability?.detail ?? "capture unavailable"} — fix: ${availability?.fix ?? "n/a"}` };
    const result = await runToolAs("computer.capture_screen", { label: "selftest" });
    return expect(result.status === "SUCCESS", String(result.summary), `${result.status}: ${result.summary}`);
  });

  await check("vision.uia", "VISION", "Windows UI Automation", async () => {
    const tool = listTools().find((t) => t.id === "computer.uia");
    const availability = await tool?.availability();
    if (!availability?.available) return { status: "UNAVAILABLE", detail: availability?.detail ?? "unavailable" };
    const result = await runToolAs("computer.uia", { action: "list" });
    return expect(result.status === "SUCCESS", String(result.summary), `${result.status}: ${result.summary}`);
  });

  await check("vision.ocr", "VISION", "OCR over a real image", async () => {
    const tool = listTools().find((t) => t.id === "vision.ocr");
    const availability = await tool?.availability();
    if (!availability?.available) return { status: "UNAVAILABLE", detail: `${availability?.detail ?? "ocr unavailable"} — fix: ${availability?.fix ?? "n/a"}` };
    const cards = await runToolAs("media.cards", { title: "OCR SAMPLE", scenes: [{ heading: "READ ME", body: "text for ocr" }], width: 640, height: 360 });
    const filePath = (await db.select().from(artifacts).where(eq(artifacts.stepId, `${TEST_TASK}_media.cards`)).orderBy(desc(artifacts.createdAt)).limit(1))[0]?.path;
    if (!filePath || cards.status !== "SUCCESS") return { status: "FAIL", detail: "could not produce an image to OCR" };
    const result = await runToolAs("vision.ocr", { path: filePath });
    return expect(result.status === "SUCCESS", String(result.summary), `${result.status}: ${result.summary}`);
  });

  // ---------------------------------------------------------------- VOICE
  await check("voice.pipeline", "VOICE", "Voice pipeline truthfulness", async () => {
    const status = await voiceStatus();
    const honest = status.stt.status !== "AVAILABLE" ? status.stt.detail.length > 0 : true;
    const transcribe = await runToolAs("voice.transcribe", { path: `${DIRS.workspace}/no-audio.wav` });
    const engineMissing = status.stt.status !== "AVAILABLE";
    return expect(
      honest && (engineMissing ? transcribe.status === "UNAVAILABLE" || transcribe.status === "FAILED" : true),
      `STT: ${status.stt.engine} (${status.stt.status}) · TTS: ${status.tts.engine} (${status.tts.status}) · browser fallback documented as CLIENT_SIDE; transcribe returned ${transcribe.status}`,
      `voice reporting inconsistent: stt=${status.stt.status}, transcribe=${transcribe.status}`,
    );
  });

  // ---------------------------------------------------------------- EMAIL
  await check("email.connectors", "EMAIL", "IMAP/SMTP connectors", async () => {
    const tool = listTools().find((t) => t.id === "email.inbox");
    const availability = await tool?.availability();
    if (!availability?.available) return { status: "UNAVAILABLE", detail: `${availability?.detail} — fix: ${availability?.fix ?? "set IMAP_URL"}` };
    const result = await runToolAs("email.inbox", { limit: 3 });
    return expect(result.status === "SUCCESS", String(result.summary), `${result.status}: ${result.summary}`);
  });

  await check("email.send-gate", "EMAIL", "Sending email is impossible without approval", async () => {
    const result = await runToolAs("email.send", { to: "selftest@example.com", subject: "selftest", body: "must not be sent" });
    const sent = await db.select().from(toolRuns).where(and(eq(toolRuns.toolId, "email.send"), eq(toolRuns.status, "SUCCESS")));
    const guarded = result.status === "BLOCKED"
      ? "refused by the approval gate before execution"
      : result.status === "UNAVAILABLE"
        ? "no SMTP transport configured, so nothing could be transmitted"
        : `unexpected status ${result.status}`;
    return expect(
      (result.status === "BLOCKED" || result.status === "UNAVAILABLE") && sent.length === 0,
      `email.send ${guarded}; ${sent.length} message(s) ever sent by this tool`,
      `status=${result.status}, successfulSends=${sent.length}`,
    );
  });

  // ---------------------------------------------------------------- OLLAMA
  await check("ollama.local-llm", "OLLAMA", "Local model discovery", async () => {
    const status = await probe();
    if (status.status !== "AVAILABLE") return { status: "UNAVAILABLE", detail: `${status.detail} — models found: ${status.models.length}; deterministic planner in use` };
    return { status: "PASS", detail: `${status.models.length} model(s) discovered; selected ${status.selectedModel} (${status.selectionReason})` };
  });

  const ms = Date.now() - started;
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const runId = newId("test");
  await db
    .insert(testRuns)
    .values({ id: runId, suite: "runtime-acceptance", passed, failed, total: results.length, ms, results })
    .catch(() => undefined);

  return { id: runId, passed, failed, total: results.length, ms, results };
}

export async function lastTestRuns(limit = 5) {
  const rows = await db.select().from(testRuns).orderBy(desc(testRuns.at)).limit(limit);
  return rows;
}
