/**
 * Resource governor for the real target machine class
 * (i7-1195G7 / 16 GB / Iris Xe / no CUDA). Heavy work is serialised and
 * deferred with an explicit, user-visible reason — never silently degraded.
 */
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { statfs } from "node:fs/promises";
import { db } from "@/db";
import { resourceSamples, type ResourceClass } from "@/db/schema";
import { appConfig, DIRS } from "@/lib/config";
import { emitSoon } from "@/lib/events";

export type ResourceSnapshot = {
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  cpuPercent: number;
  loadPerCore: number;
  totalMemMb: number;
  freeMemMb: number;
  diskFreeMb: number;
  gpu: { cuda: boolean; detail: string };
  pressure: "NORMAL" | "ELEVATED" | "CRITICAL";
  activeSteps: number;
  heavyActive: number;
  explanation: string;
  at: string;
};

let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();
let cached: { snapshot: ResourceSnapshot; expires: number } | null = null;
let activeSteps = 0;
let heavyActive = 0;
let lastSampleAt = 0;

function cpuPercentSince(): number {
  const usage = process.cpuUsage(lastCpu);
  const elapsedMs = Math.max(1, Date.now() - lastCpuAt);
  lastCpu = process.cpuUsage();
  lastCpuAt = Date.now();
  const cores = Math.max(1, cpus().length);
  const percent = ((usage.user + usage.system) / 1000 / elapsedMs / cores) * 100;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

async function diskFreeMb(): Promise<number> {
  try {
    const stats = await statfs(DIRS.root);
    return Math.round((stats.bavail * stats.bsize) / 1024 / 1024);
  } catch {
    return -1;
  }
}

export async function snapshot(force = false): Promise<ResourceSnapshot> {
  if (!force && cached && cached.expires > Date.now()) return cached.snapshot;
  const config = await appConfig();
  const cpuList = cpus();
  const total = totalmem();
  const free = freemem();
  const loadPerCore = loadavg()[0] / Math.max(1, cpuList.length);
  const cpuPercent = cpuPercentSince();
  const freeMemMb = Math.round(free / 1024 / 1024);
  const disk = await diskFreeMb();

  let pressure: ResourceSnapshot["pressure"] = "NORMAL";
  const notes: string[] = [];
  if (freeMemMb < config.resource.minFreeRamMb) {
    pressure = "CRITICAL";
    notes.push(`free RAM ${freeMemMb}MB is below the ${config.resource.minFreeRamMb}MB floor`);
  } else if (freeMemMb < config.resource.minFreeRamMb * 2) {
    pressure = "ELEVATED";
    notes.push(`free RAM is low (${freeMemMb}MB)`);
  }
  if (loadPerCore > config.resource.heavyCpuLoadPerCore) {
    pressure = pressure === "CRITICAL" ? "CRITICAL" : "ELEVATED";
    notes.push(`load ${loadPerCore.toFixed(2)}/core exceeds the HEAVY threshold ${config.resource.heavyCpuLoadPerCore}`);
  }
  if (heavyActive >= config.autonomy.maxConcurrentHeavy) {
    pressure = pressure === "CRITICAL" ? "CRITICAL" : "ELEVATED";
    notes.push(`${heavyActive} heavy step(s) already running (limit ${config.autonomy.maxConcurrentHeavy})`);
  }
  if (disk >= 0 && disk < 512) {
    pressure = "CRITICAL";
    notes.push(`only ${disk}MB disk free`);
  }

  const result: ResourceSnapshot = {
    platform: `${process.platform}-${process.arch}`,
    arch: process.arch,
    cpuModel: cpuList[0]?.model ?? "unknown",
    cpuCount: cpuList.length,
    cpuPercent,
    loadPerCore: Number(loadPerCore.toFixed(2)),
    totalMemMb: Math.round(total / 1024 / 1024),
    freeMemMb,
    diskFreeMb: disk,
    gpu: {
      cuda: false,
      detail: /nvidia/i.test(cpuList[0]?.model ?? "") ? "CPU-attached NVIDIA adapter suspected" : "no CUDA runtime probe configured",
    },
    pressure,
    activeSteps,
    heavyActive,
    explanation: notes.length ? notes.join("; ") : "within configured limits",
    at: new Date().toISOString(),
  };
  cached = { snapshot: result, expires: Date.now() + 1500 };

  if (Date.now() - lastSampleAt > 5000) {
    lastSampleAt = Date.now();
    const sample = result;
    emitSoon({
      topic: "resource.sample",
      level: sample.pressure === "CRITICAL" ? "warn" : "info",
      message: `resources ${sample.pressure}: cpu ${sample.cpuPercent}% · free ${sample.freeMemMb}MB · load/core ${sample.loadPerCore}`,
      payload: { pressure: sample.pressure, freeMemMb: sample.freeMemMb, cpuPercent: sample.cpuPercent },
    });
    void db
      .insert(resourceSamples)
      .values({
        cpuPercent: sample.cpuPercent,
        loadPerCore: Math.round(sample.loadPerCore * 100),
        totalMemMb: sample.totalMemMb,
        freeMemMb: sample.freeMemMb,
        diskFreeMb: Math.max(0, sample.diskFreeMb),
        activeSteps: sample.activeSteps,
        pressure: sample.pressure,
      })
      .catch(() => undefined);
  }
  return result;
}

export type Admission = { admitted: boolean; reason: string; snapshot: ResourceSnapshot };

export async function admit(resourceClass: ResourceClass): Promise<Admission> {
  const config = await appConfig();
  const snap = await snapshot(true);
  if (resourceClass === "LIGHT" || resourceClass === "MEDIUM") {
    return { admitted: true, reason: "light/medium work admitted", snapshot: snap };
  }
  if (snap.freeMemMb < config.resource.minFreeRamMb) {
    return {
      admitted: false,
      reason: `deferred: free RAM ${snap.freeMemMb}MB below floor ${config.resource.minFreeRamMb}MB`,
      snapshot: snap,
    };
  }
  if (heavyActive >= config.autonomy.maxConcurrentHeavy) {
    return {
      admitted: false,
      reason: `deferred: ${heavyActive} heavy step(s) already running (max ${config.autonomy.maxConcurrentHeavy})`,
      snapshot: snap,
    };
  }
  if (snap.loadPerCore > config.resource.heavyCpuLoadPerCore * 1.5) {
    return {
      admitted: false,
      reason: `deferred: host load ${snap.loadPerCore}/core is too high for ${resourceClass} work`,
      snapshot: snap,
    };
  }
  return { admitted: true, reason: `${resourceClass} work admitted`, snapshot: snap };
}

export function trackStepStart(resourceClass: ResourceClass): void {
  activeSteps += 1;
  if (resourceClass === "HEAVY" || resourceClass === "EXCLUSIVE") heavyActive += 1;
}

export function trackStepEnd(resourceClass: ResourceClass): void {
  activeSteps = Math.max(0, activeSteps - 1);
  if (resourceClass === "HEAVY" || resourceClass === "EXCLUSIVE") heavyActive = Math.max(0, heavyActive - 1);
}
