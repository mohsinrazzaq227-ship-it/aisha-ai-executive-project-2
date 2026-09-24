#!/usr/bin/env node
/**
 * Executes the runtime acceptance suite against a running AISHA service and
 * writes a verification report (docs/VERIFICATION.md) from the real results.
 *
 *   node scripts/run-verification.mjs [baseUrl]
 *
 * Exit code is 0 when there are no FAIL results, 1 otherwise. UNAVAILABLE is not
 * a failure: it means the capability was probed and honestly reported as absent
 * on this host, and it is written into the report with its reason.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.argv[2] ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;

async function main() {
  const health = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
  console.log("health:", JSON.stringify(health).slice(0, 400));

  const system = await fetch(`${baseUrl}/api/system`).then((r) => r.json());
  const doctor = system.doctor;

  const run = await fetch(`${baseUrl}/api/tests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "run-acceptance-suite" }),
  }).then((r) => r.json());

  const passed = run.results.filter((r) => r.status === "PASS");
  const failed = run.results.filter((r) => r.status === "FAIL");
  const unavailable = run.results.filter((r) => r.status === "UNAVAILABLE");
  const areas = [...new Set(run.results.map((r) => r.area))];

  const lines = [
    "# AISHA — verification report",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Base URL: ${baseUrl}`,
    `Health: ${health.status} (${Object.entries(health.checks ?? {}).map(([k, v]) => `${k}=${v.ok ? "ok" : "FAIL"}`).join(", ")})`,
    "",
    "## Runtime acceptance summary",
    "",
    `- PASS: ${passed.length}`,
    `- FAIL: ${failed.length}`,
    `- UNAVAILABLE (probed, absent on this host, reason recorded): ${unavailable.length}`,
    `- total checks: ${run.results.length} in ${run.ms} ms`,
    "",
    "## Per-area result",
    "",
    "| Area | PASS | FAIL | UNAVAILABLE |",
    "| --- | --- | --- | --- |",
    ...areas.map((area) => {
      const scoped = run.results.filter((r) => r.area === area);
      return `| ${area} | ${scoped.filter((r) => r.status === "PASS").length} | ${scoped.filter((r) => r.status === "FAIL").length} | ${scoped.filter((r) => r.status === "UNAVAILABLE").length} |`;
    }),
    "",
    "## Every check",
    "",
    "| Area | Check | Status | ms | Evidence / reason |",
    "| --- | --- | --- | --- | --- |",
    ...run.results.map((r) => `| ${r.area} | ${r.name} | ${r.status} | ${r.ms} | ${String(r.detail).replace(/\|/g, "/").slice(0, 300)} |`),
    "",
    "## Capability verdicts from /api/doctor (live probes)",
    "",
    "| Capability | Status | Detail | Fix |",
    "| --- | --- | --- | --- |",
    ...doctor.capabilities.map((c) => `| ${c.label} | ${c.status} | ${String(c.detail).replace(/\|/g, "/").slice(0, 220)} | ${c.fix ?? "—"} |`),
    "",
    "> Deterministic renders are never reported as AI generation. UNAVAILABLE entries are host limitations, not passes.",
    "",
  ];

  const target = path.join(process.cwd(), "docs", "VERIFICATION.md");
  await writeFile(target, lines.join("\n"), "utf8");
  console.log(`wrote ${target}`);
  console.log(`result: ${passed.length} pass / ${failed.length} fail / ${unavailable.length} unavailable`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error("verification run failed:", error);
  process.exit(2);
});
