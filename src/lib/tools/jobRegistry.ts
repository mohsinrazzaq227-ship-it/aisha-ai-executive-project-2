import type { ChildProcess } from "node:child_process";

/**
 * Live registry of running child processes (FFmpeg, Whisper, archive tools...).
 * Cancellation is real: stopping a task kills the actual operating system
 * process, it does not merely flip a UI state.
 */
type Job = { taskId: string; child: ChildProcess; startedAt: number };

const globalForJobs = globalThis as typeof globalThis & { __aiExecJobs?: Map<string, Job> };
const jobs: Map<string, Job> = globalForJobs.__aiExecJobs ?? new Map<string, Job>();
globalForJobs.__aiExecJobs = jobs;

export const ffmpegJobs = {
  register(taskId: string, jobId: string, child: ChildProcess): void {
    jobs.set(jobId, { taskId, child, startedAt: Date.now() });
  },
  finish(jobId: string): void {
    jobs.delete(jobId);
  },
  killTask(taskId: string): number {
    let killed = 0;
    for (const [jobId, job] of jobs.entries()) {
      if (job.taskId !== taskId) continue;
      try {
        job.child.kill("SIGKILL");
        killed += 1;
      } catch {
        /* already gone */
      }
      jobs.delete(jobId);
    }
    return killed;
  },
  list(): { jobId: string; taskId: string; pid?: number; runningForMs: number }[] {
    return Array.from(jobs.entries()).map(([jobId, job]) => ({
      jobId,
      taskId: job.taskId,
      pid: job.child.pid,
      runningForMs: Date.now() - job.startedAt,
    }));
  },
};
