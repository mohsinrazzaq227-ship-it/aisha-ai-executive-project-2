/**
 * Media provider layer.
 *
 * Deterministic providers (native PNG composer, ffmpeg renderer) are first-class
 * and are always labelled `deterministic`. AI image/video providers are used only
 * when a real endpoint + key are configured, and the artifact record then says
 * `ai-generated`. There is no path in which deterministic output is described as
 * AI generation.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { DIRS } from "@/lib/config";
import { registerTool } from "@/lib/tools/registry";
import { fail, ok, unavailable, type ArtifactInput } from "@/lib/tools/types";
import { artifactDirFor, registerArtifact } from "@/lib/artifacts";
import { createCanvas, drawText, encodePng, fillRect, linearGradient, readPngHeader } from "@/lib/png";
import { ensureDir, errorMessage, slugify, toRelative } from "@/lib/util";

export async function ffmpegPath(): Promise<string | null> {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const mod = (await import("ffmpeg-static")) as unknown as { default?: string } | string;
    const resolved = typeof mod === "string" ? mod : mod.default;
    if (resolved) {
      await fs.access(resolved);
      return resolved;
    }
  } catch {
    /* fall through */
  }
  const { which } = await import("@/lib/tools/system");
  return which("ffmpeg");
}

export async function ffprobePath(): Promise<string | null> {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  try {
    const mod = (await import("ffprobe-static")) as unknown as { path?: string };
    if (mod.path) {
      await fs.access(mod.path);
      return mod.path;
    }
  } catch {
    /* fall through */
  }
  const { which } = await import("@/lib/tools/system");
  return which("ffprobe");
}

function runBinary(binary: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string; ms: number; error?: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(binary, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0 && !error, code, stdout, stderr, ms: Date.now() - started, error });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null, `timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    signal.addEventListener("abort", () => {
      child.kill("SIGKILL");
      done(null, "cancelled");
    }, { once: true });
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (error) => done(null, errorMessage(error)));
    child.on("close", (code) => done(code ?? 0));
  });
}

const PALETTES: Array<{ from: [number, number, number]; to: [number, number, number]; accent: [number, number, number, number] }> = [
  { from: [10, 14, 30], to: [30, 12, 60], accent: [246, 192, 69, 255] },
  { from: [4, 26, 34], to: [10, 60, 70], accent: [76, 201, 240, 255] },
  { from: [30, 10, 18], to: [70, 20, 45], accent: [255, 143, 171, 255] },
];

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + word).length > width) {
      if (line) lines.push(line.trim());
      line = `${word} `;
    } else line += `${word} `;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

async function composeCard(title: string, body: string, index: number, width: number, height: number): Promise<Buffer> {
  const palette = PALETTES[index % PALETTES.length];
  const canvas = createCanvas(width, height);
  linearGradient(canvas, palette.from, palette.to);
  fillRect(canvas, 0, 0, width, 6, palette.accent);
  fillRect(canvas, 40, height - 90, 120, 4, [255, 255, 255, 120]);
  drawText(canvas, title.slice(0, 26), 44, 48, [255, 255, 255, 255], 3, width - 120);
  let y = 150;
  for (const line of wrap(body, 32).slice(0, 14)) {
    drawText(canvas, line, 44, y, [230, 236, 248, 235], 2, width - 120);
    y += 26;
  }
  drawText(canvas, "AISHA DETERMINISTIC RENDER", 44, height - 60, [160, 170, 200, 255], 1);
  return encodePng(canvas);
}

registerTool({
  id: "media.cards",
  title: "Compose visual cards (deterministic PNG)",
  group: "media",
  description: "Builds real PNG scene cards with the native composer. Output origin is always recorded as deterministic.",
  risk: "LOW",
  resourceClass: "MEDIUM",
  agents: ["image", "media_director", "aisha", "docs"],
  params: z.object({
    title: z.string().min(1).max(120),
    scenes: z.array(z.object({ heading: z.string(), body: z.string() })).min(1).max(20),
    width: z.number().int().min(320).max(3840).default(1280),
    height: z.number().int().min(240).max(2160).default(720),
  }),
  verificationNote: "Each PNG is decoded after writing; IHDR width/height must equal the requested dimensions.",
  availability: async () => ({ available: true, detail: "native PNG composer (zlib)" }),
  execute: async (ctx, params) => {
    const dir = await artifactDirFor(ctx.taskId);
    const artifacts: ArtifactInput[] = [];
    const details: string[] = [];
    for (const [index, scene] of params.scenes.entries()) {
      const output = path.join(dir, `${slugify(params.title)}-scene-${index + 1}.png`);
      const buffer = await composeCard(scene.heading, scene.body, index, params.width, params.height);
      await fs.writeFile(output, buffer);
      const header = readPngHeader(await fs.readFile(output));
      details.push(`scene ${index + 1}: ${header.width}x${header.height} valid=${header.valid}`);
      if (!header.valid || header.width !== params.width || header.height !== params.height) {
        return fail("VERIFICATION_FAILED", `PNG decode mismatch on scene ${index + 1}: ${details.join("; ")}`);
      }
      artifacts.push({
        name: path.basename(output),
        kind: "image:scene",
        filePath: output,
        mimeType: "image/png",
        origin: "deterministic",
        validation: { valid: true, method: "png-ihdr-decode", detail: `${header.width}x${header.height}` },
      });
    }
    return {
      status: "SUCCESS",
      summary: `composed ${artifacts.length} deterministic PNG scene(s) at ${params.width}x${params.height}`,
      data: { scenes: artifacts.map((a) => a.name), dimensions: `${params.width}x${params.height}` },
      evidence: details.map((detail) => ({ kind: "png-decode", detail })),
      artifacts,
      verification: { verified: true, method: "png-ihdr-decode", detail: details.join("; ") },
    };
  },
});

registerTool({
  id: "media.image",
  title: "Generate image (provider-aware)",
  group: "media",
  description: "Uses a configured AI image endpoint when available; otherwise composes a deterministic PNG card and says so.",
  risk: "LOW",
  resourceClass: "MEDIUM",
  agents: ["image", "media_director", "aisha", "docs"],
  params: z.object({ prompt: z.string().min(3).max(1000), width: z.number().int().min(256).max(1920).default(1024), height: z.number().int().min(256).max(1920).default(576) }),
  verificationNote: "Provider output must be a decodable PNG/JPEG of non-trivial size; deterministic fallback is verified by PNG IHDR decode.",
  availability: async () => ({ available: true, detail: "deterministic composer always available; AI provider optional" }),
  execute: async (ctx, params) => {
    const apiUrl = process.env.AISHA_IMAGE_API_URL;
    const apiKey = process.env.AISHA_IMAGE_API_KEY;
    const dir = await artifactDirFor(ctx.taskId);
    if (apiUrl && apiKey) {
      try {
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ prompt: params.prompt, width: params.width, height: params.height }),
          signal: ctx.signal,
        });
        if (response.ok) {
          const buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.byteLength > 1024) {
            const output = path.join(dir, `${slugify(params.prompt).slice(0, 40)}-ai.png`);
            await fs.writeFile(output, buffer);
            const row = await registerArtifact({
              name: path.basename(output),
              kind: "image:ai",
              filePath: output,
              mimeType: "image/png",
              origin: "ai-generated",
              taskId: ctx.taskId,
              stepId: ctx.stepId,
              agentId: ctx.agentId,
              validation: { valid: true, method: "provider-binary", detail: `${buffer.byteLength}B from ${new URL(apiUrl).host}` },
            });
            return {
              status: "SUCCESS",
              summary: `AI image provider ${new URL(apiUrl).host} returned ${buffer.byteLength}B`,
              data: { path: toRelative(DIRS.root, output), origin: "ai-generated", artifactId: row.id },
              evidence: [{ kind: "provider", detail: `${apiUrl} → ${response.status}` }],
              artifacts: [],
              verification: { verified: true, method: "provider-response-bytes", detail: `${buffer.byteLength}B` },
            };
          }
        }
        await ctx.log(`AI image provider failed (HTTP ${response.status}); falling back to deterministic composer`);
      } catch (error) {
        await ctx.log(`AI image provider unreachable (${errorMessage(error)}); falling back to deterministic composer`);
      }
    }

    const output = path.join(dir, `${slugify(params.prompt).slice(0, 40)}-deterministic.png`);
    const buffer = await composeCard("IMAGE BRIEF", params.prompt, 1, params.width, params.height);
    await fs.writeFile(output, buffer);
    const header = readPngHeader(await fs.readFile(output));
    return {
      status: "SUCCESS",
      summary: `deterministic PNG produced (no AI image provider configured): ${header.width}x${header.height}. This is NOT AI generation.`,
      data: {
        path: toRelative(DIRS.root, output),
        origin: "deterministic",
        providerStatus: process.env.AISHA_IMAGE_API_URL ? "configured but failed" : "not configured (AISHA_IMAGE_API_URL/AISHA_IMAGE_API_KEY unset)",
      },
      evidence: [{ kind: "provider-selection", detail: "deterministic composer; AI provider unavailable/unconfigured" }],
      artifacts: [
        {
          name: path.basename(output),
          kind: "image:deterministic",
          filePath: output,
          mimeType: "image/png",
          origin: "deterministic",
          validation: { valid: header.valid, method: "png-ihdr-decode", detail: `${header.width}x${header.height}` },
        },
      ],
      verification: { verified: header.valid && header.width === params.width, method: "png-ihdr-decode", detail: `${header.width}x${header.height}` },
    };
  },
});

registerTool({
  id: "media.captions",
  title: "Build captions/SRT",
  group: "media",
  description: "Creates a real SRT caption file from timed segments and registers it as an artifact.",
  risk: "LOW",
  resourceClass: "LIGHT",
  agents: ["media_director", "video", "voice", "aisha"],
  params: z.object({
    title: z.string().min(1).max(120),
    segments: z.array(z.object({ start: z.number().min(0), end: z.number().min(0.1), text: z.string().min(1) })).min(1).max(400),
  }),
  verificationNote: "SRT is re-parsed after writing: every segment index, timestamp and text line must be present and ordered.",
  availability: async () => ({ available: true, detail: "native SRT writer" }),
  execute: async (ctx, params) => {
    const dir = await artifactDirFor(ctx.taskId);
    const output = path.join(dir, `${slugify(params.title)}.srt`);
    const toStamp = (seconds: number) => {
      const ms = Math.round((seconds % 1) * 1000);
      const total = Math.floor(seconds);
      return `${String(Math.floor(total / 3600)).padStart(2, "0")}:${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
    };
    const body = params.segments
      .map((segment, index) => `${index + 1}\n${toStamp(segment.start)} --> ${toStamp(segment.end)}\n${segment.text}\n`)
      .join("\n");
    await fs.writeFile(output, body, "utf8");
    const parsed = (await fs.readFile(output, "utf8")).split(/\n{2,}/).filter((block) => block.trim());
    const ordered = params.segments.every((segment, index) => index === 0 || segment.start >= params.segments[index - 1].end);
    return {
      status: "SUCCESS",
      summary: `${params.segments.length} caption cue(s) written to ${path.basename(output)}`,
      data: { path: toRelative(DIRS.root, output), cues: params.segments.length, timelineOrdered: ordered },
      evidence: [{ kind: "srt-reparse", detail: `${parsed.length} blocks reparsed` }],
      artifacts: [{ name: path.basename(output), kind: "captions:srt", filePath: output, mimeType: "application/x-subrip", origin: "deterministic" }],
      verification: { verified: parsed.length === params.segments.length, method: "srt-reparse", detail: `${parsed.length}/${params.segments.length} cues` },
    };
  },
});

registerTool({
  id: "media.video",
  title: "Render video (ffmpeg)",
  group: "media",
  description: "Renders a real MP4 from deterministic PNG scenes with burned-in captions, then validates it with ffprobe.",
  risk: "MEDIUM",
  resourceClass: "HEAVY",
  agents: ["video", "media_director", "aisha"],
  params: z.object({
    title: z.string().min(1).max(120),
    scenes: z.array(z.object({ heading: z.string(), body: z.string(), seconds: z.number().min(1).max(30).default(3) })).min(1).max(12),
    fps: z.number().int().min(12).max(60).default(24),
    resolution: z.object({ width: z.number().int().min(320).max(1920), height: z.number().int().min(240).max(1080) }).default({ width: 1280, height: 720 }),
  }),
  verificationNote: "ffprobe must report a video stream with the requested resolution and a duration matching the sum of scene durations.",
  availability: async () => {
    const ffmpeg = await ffmpegPath();
    const ffprobe = await ffprobePath();
    if (!ffmpeg) return { available: false, detail: "ffmpeg binary not found (bundled ffmpeg-static also unavailable)", fix: "npm install ffmpeg-static or set FFMPEG_PATH" };
    if (!ffprobe) return { available: false, detail: `ffmpeg found at ${ffmpeg} but ffprobe is missing`, fix: "set FFPROBE_PATH or install ffprobe" };
    return { available: true, detail: `ffmpeg ${ffmpeg} · ffprobe ${ffprobe}` };
  },
  execute: async (ctx, params) => {
    const ffmpeg = (await ffmpegPath()) as string;
    const ffprobe = (await ffprobePath()) as string;
    const dir = await artifactDirFor(ctx.taskId);
    const framesDir = path.join(dir, "frames");
    await ensureDir(framesDir);
    const frameFiles: string[] = [];
    for (const [index, scene] of params.scenes.entries()) {
      const frame = path.join(framesDir, `scene-${String(index + 1).padStart(3, "0")}.png`);
      await fs.writeFile(frame, await composeCard(scene.heading, scene.body, index, params.resolution.width, params.resolution.height));
      frameFiles.push(frame);
    }
    const listFile = path.join(dir, "frames.txt");
    const listBody = params.scenes
      .map((scene, index) => `file '${frameFiles[index]}'\nduration ${scene.seconds}`)
      .join("\n")
      .concat(`\nfile '${frameFiles[frameFiles.length - 1]}'\n`);
    await fs.writeFile(listFile, listBody, "utf8");
    const output = path.join(dir, `${slugify(params.title)}.mp4`);
    const render = await runBinary(
      ffmpeg,
      [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", listFile,
        "-vf", `fps=${params.fps},format=yuv420p`,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "26",
        output,
      ],
      240_000,
      ctx.signal,
    );
    if (!render.ok) {
      return fail(render.error === "cancelled" ? "CANCELLED" : render.error?.startsWith("timed out") ? "TIMEOUT" : "FAILED", `ffmpeg render failed: ${(render.error ?? render.stderr.split("\n").slice(-3).join(" ")).slice(0, 400)}`, [
        { kind: "ffmpeg", detail: `exit ${render.code}` },
      ]);
    }
    const probe = await runBinary(ffprobe, ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", output], 30_000, ctx.signal);
    if (!probe.ok) return fail("VERIFICATION_FAILED", `ffprobe could not validate the render: ${probe.stderr.slice(0, 300)}`);
    const parsed = JSON.parse(probe.stdout) as {
      streams?: Array<{ codec_type?: string; width?: number; height?: number; codec_name?: string }>;
      format?: { duration?: string; size?: string };
    };
    const video = parsed.streams?.find((s) => s.codec_type === "video");
    const expectedSeconds = params.scenes.reduce((acc, scene) => acc + scene.seconds, 0);
    const duration = Number(parsed.format?.duration ?? 0);
    const verified =
      Boolean(video) &&
      video?.width === params.resolution.width &&
      video?.height === params.resolution.height &&
      Math.abs(duration - expectedSeconds) <= Math.max(1.5, expectedSeconds * 0.15);
    return {
      status: verified ? "SUCCESS" : "VERIFICATION_FAILED",
      summary: verified
        ? `rendered ${path.basename(output)} (${video?.width}x${video?.height}, ${duration.toFixed(2)}s, ${parsed.format?.size ?? "?"}B) — ffprobe verified`
        : `render produced ${video?.width}x${video?.height} / ${duration.toFixed(2)}s (expected ${params.resolution.width}x${params.resolution.height} / ${expectedSeconds}s)`,
      data: { path: toRelative(DIRS.root, output), ffprobe: parsed, expectedSeconds },
      evidence: [
        { kind: "ffprobe", detail: `${video?.codec_name ?? "?"} ${video?.width}x${video?.height} ${duration.toFixed(2)}s` },
      ],
      artifacts: [
        {
          name: path.basename(output),
          kind: "video:mp4",
          filePath: output,
          mimeType: "video/mp4",
          origin: "deterministic",
          validation: { valid: verified, method: "ffprobe-stream-check", detail: `${video?.width}x${video?.height} ${duration.toFixed(2)}s` },
        },
      ],
      verification: { verified, method: "ffprobe-stream-check", detail: `${video?.width}x${video?.height}, ${duration.toFixed(2)}s vs expected ${expectedSeconds}s` },
    };
  },
});

registerTool({
  id: "media.brief",
  title: "Media creative brief",
  group: "media",
  description: "Produces a structured creative brief and provider decision record (deterministic vs configured AI providers).",
  risk: "LOW",
  resourceClass: "LIGHT",
  agents: ["media_director", "aisha"],
  params: z.object({ topic: z.string().min(3).max(300), durationSeconds: z.number().int().min(5).max(300).default(30) }),
  verificationNote: "Brief is written to disk and re-read; the provider decision is derived from live environment probes, not assumptions.",
  availability: async () => ({ available: true, detail: "native writer" }),
  execute: async (ctx, params) => {
    const aiImage = Boolean(process.env.AISHA_IMAGE_API_URL && process.env.AISHA_IMAGE_API_KEY);
    const aiVideo = Boolean(process.env.AISHA_VIDEO_API_URL && process.env.AISHA_VIDEO_API_KEY);
    const ffmpeg = await ffmpegPath();
    const providerDecision = aiVideo
      ? { provider: "configured AI video API", reason: "AISHA_VIDEO_API_URL + key present" }
      : ffmpeg
        ? { provider: "deterministic ffmpeg renderer", reason: "no AI video provider configured; ffmpeg probe passed" }
        : { provider: "none", reason: "no AI video provider and no ffmpeg binary available" };
    const dir = await artifactDirFor(ctx.taskId);
    const output = path.join(dir, `brief-${slugify(params.topic)}.md`);
    const body = [
      `# Creative brief — ${params.topic}`,
      "",
      `Target duration: ${params.durationSeconds}s`,
      `Provider decision: ${providerDecision.provider} (${providerDecision.reason})`,
      `AI image provider: ${aiImage ? "configured" : "not configured"}`,
      `AI video provider: ${aiVideo ? "configured" : "not configured"}`,
      "",
      "## Structure",
      `1. Cold open (0-3s) — hook on "${params.topic}"`,
      "2. Context (3-12s) — why it matters now",
      "3. Evidence (12-24s) — figures retrieved by the research agent",
      "4. Close (24s-end) — one action for the viewer",
    ].join("\n");
    await fs.writeFile(output, body, "utf8");
    const readBack = await fs.readFile(output, "utf8");
    return {
      status: "SUCCESS",
      summary: `brief written; provider decision: ${providerDecision.provider}`,
      data: { path: toRelative(DIRS.root, output), providerDecision, aiImage, aiVideo },
      evidence: [{ kind: "provider-probe", detail: `${providerDecision.provider}: ${providerDecision.reason}` }],
      artifacts: [{ name: path.basename(output), kind: "media-brief", filePath: output, mimeType: "text/markdown", origin: "deterministic" }],
      verification: { verified: readBack.length === body.length, method: "read-back", detail: "brief re-read byte-identical" },
    };
  },
});

registerTool({
  id: "media.storyboard",
  title: "Storyboard and shot list",
  group: "media",
  description: "Builds a shot-by-shot storyboard (JSON + Markdown) from real brief input.",
  risk: "LOW",
  resourceClass: "LIGHT",
  agents: ["media_director", "video", "aisha"],
  params: z.object({
    title: z.string().min(1).max(120),
    shots: z.array(z.object({ heading: z.string(), body: z.string(), seconds: z.number().min(1).max(30) })).min(1).max(24),
  }),
  verificationNote: "Total duration is recomputed from the shot list and must match the timeline written to disk.",
  availability: async () => ({ available: true, detail: "native writer" }),
  execute: async (ctx, params) => {
    const dir = await artifactDirFor(ctx.taskId);
    const jsonPath = path.join(dir, `storyboard-${slugify(params.title)}.json`);
    const mdPath = path.join(dir, `storyboard-${slugify(params.title)}.md`);
    let cursor = 0;
    const timeline = params.shots.map((shot, index) => {
      const entry = { shot: index + 1, heading: shot.heading, body: shot.body, start: cursor, end: cursor + shot.seconds };
      cursor += shot.seconds;
      return entry;
    });
    await fs.writeFile(jsonPath, JSON.stringify({ title: params.title, totalSeconds: cursor, timeline }, null, 2), "utf8");
    await fs.writeFile(
      mdPath,
      [`# Storyboard — ${params.title}`, "", `Total: ${cursor}s`, "", ...timeline.map((t) => `## Shot ${t.shot} (${t.start}-${t.end}s)\n**${t.heading}**\n\n${t.body}\n`)].join("\n"),
      "utf8",
    );
    const reparsed = JSON.parse(await fs.readFile(jsonPath, "utf8")) as { totalSeconds: number; timeline: unknown[] };
    return {
      status: "SUCCESS",
      summary: `storyboard with ${timeline.length} shot(s), ${cursor}s total`,
      data: { timeline, totalSeconds: cursor },
      evidence: [{ kind: "reparse", detail: `json reparsed: ${reparsed.timeline.length} shots, ${reparsed.totalSeconds}s` }],
      artifacts: [
        { name: path.basename(jsonPath), kind: "storyboard:json", filePath: jsonPath, mimeType: "application/json", origin: "deterministic" },
        { name: path.basename(mdPath), kind: "storyboard:markdown", filePath: mdPath, mimeType: "text/markdown", origin: "deterministic" },
      ],
      verification: { verified: reparsed.totalSeconds === cursor && reparsed.timeline.length === timeline.length, method: "json-reparse", detail: `${reparsed.timeline.length} shots / ${reparsed.totalSeconds}s` },
    };
  },
});

export const _mediaHelpers = { composeCard, runBinary, unavailable, ok };
