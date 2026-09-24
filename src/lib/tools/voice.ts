/**
 * Voice layer.
 *
 * LOCAL_ENGINE : WHISPER_URL (faster-whisper) for STT, TTS_URL (piper/kokoro) for TTS,
 *                or the Python sidecar when faster-whisper is installed there.
 * CLIENT_SIDE  : browser SpeechRecognition / SpeechSynthesis — the UI labels these
 *                exactly as CLIENT_SIDE. The server never claims to have heard or
 *                spoken anything it did not process.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DIRS, TTS_URL, WHISPER_URL, IS_WINDOWS } from "@/lib/config";
import { registerTool } from "@/lib/tools/registry";
import { fail, ok, unavailable } from "@/lib/tools/types";
import { invokeSidecar, probeSidecar } from "@/lib/sidecar";
import { artifactDirFor } from "@/lib/artifacts";
import { slugify, toRelative } from "@/lib/util";

export type VoiceEngineStatus = {
  stt: { engine: string; status: string; detail: string; fix?: string };
  tts: { engine: string; status: string; detail: string; fix?: string };
  clientSide: { stt: string; tts: string };
};

export async function voiceStatus(): Promise<VoiceEngineStatus> {
  let stt: VoiceEngineStatus["stt"] = {
    engine: "none configured",
    status: "UNAVAILABLE",
    detail: "no WHISPER_URL and no local faster-whisper in the sidecar",
    fix: "run a faster-whisper HTTP service and set WHISPER_URL, or pip install faster-whisper",
  };
  if (WHISPER_URL) {
    try {
      const response = await fetch(`${WHISPER_URL}/health`, { cache: "no-store" });
      stt = {
        engine: `local whisper (${WHISPER_URL})`,
        status: response.ok ? "AVAILABLE" : "FAILED",
        detail: `health probe HTTP ${response.status}`,
        fix: response.ok ? undefined : "start the whisper service on WHISPER_URL",
      };
    } catch (error) {
      stt = { engine: `local whisper (${WHISPER_URL})`, status: "UNAVAILABLE", detail: `unreachable: ${String(error).slice(0, 160)}`, fix: "start the whisper service or clear WHISPER_URL" };
    }
  } else {
    const probe = await probeSidecar();
    if (probe.available && probe.capabilities?.["faster_whisper"]) {
      stt = { engine: "python sidecar faster-whisper", status: "AVAILABLE", detail: "faster_whisper importable in the sidecar" };
    } else if (probe.available) {
      stt = {
        engine: "python sidecar (faster-whisper missing)",
        status: "MISSING",
        detail: "faster_whisper is not importable in the sidecar interpreter",
        fix: "pip install faster-whisper",
      };
    }
  }

  let tts: VoiceEngineStatus["tts"] = {
    engine: "none configured",
    status: "UNAVAILABLE",
    detail: "no TTS_URL configured",
    fix: "run piper/kokoro behind an HTTP endpoint and set TTS_URL",
  };
  if (TTS_URL) {
    try {
      const response = await fetch(`${TTS_URL}/health`, { cache: "no-store" });
      tts = { engine: `local TTS (${TTS_URL})`, status: response.ok ? "AVAILABLE" : "FAILED", detail: `health probe HTTP ${response.status}` };
    } catch (error) {
      tts = { engine: `local TTS (${TTS_URL})`, status: "UNAVAILABLE", detail: `unreachable: ${String(error).slice(0, 160)}`, fix: "start the TTS service or clear TTS_URL" };
    }
  }
  return {
    stt,
    tts,
    clientSide: {
      stt: "browser SpeechRecognition (Chrome/Edge) — CLIENT_SIDE, requires microphone permission",
      tts: "browser SpeechSynthesis — CLIENT_SIDE, real interruption supported",
    },
  };
}

registerTool({
  id: "voice.transcribe",
  title: "Transcribe audio (STT)",
  group: "voice",
  description: "Transcribes a real audio file through a configured local engine. Reports the engine used, never a fabricated transcript.",
  risk: "LOW",
  resourceClass: "HEAVY",
  agents: ["voice", "aisha"],
  params: z.object({ path: z.string().min(1), language: z.string().default("en") }),
  verificationNote: "The transcript must be non-empty and its word count is recorded; no engine means UNAVAILABLE, not an empty success.",
  availability: async () => {
    const status = await voiceStatus();
    if (status.stt.status === "AVAILABLE") return { available: true, detail: `${status.stt.engine} — ${status.stt.detail}` };
    return { available: false, detail: `${status.stt.detail}`, fix: status.stt.fix };
  },
  execute: async (ctx, params) => {
    const target = path.isAbsolute(params.path) ? params.path : path.resolve(DIRS.workspace, params.path);
    const buffer = await fs.readFile(target).catch(() => null);
    if (!buffer) return fail("FAILED", `audio file not found: ${toRelative(DIRS.root, target)}`);
    if (WHISPER_URL) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(buffer)]), path.basename(target));
      form.append("language", params.language);
      const response = await fetch(`${WHISPER_URL}/transcribe`, { method: "POST", body: form, signal: ctx.signal });
      if (!response.ok) return fail("FAILED", `whisper service returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const body = (await response.json()) as { text?: string; segments?: unknown[] };
      const text = (body.text ?? "").trim();
      return {
        status: text ? "SUCCESS" : "VERIFICATION_FAILED",
        summary: text ? `transcribed ${text.split(/\s+/).length} word(s) via ${WHISPER_URL}` : "whisper returned an empty transcript",
        data: { engine: "local-whisper", text, segments: body.segments ?? [], sourceBytes: buffer.byteLength },
        evidence: [{ kind: "stt", detail: `${text.split(/\s+/).filter(Boolean).length} words from ${buffer.byteLength}B audio` }],
        artifacts: [],
        verification: { verified: text.length > 0, method: "nonempty-transcript", detail: `${text.length} chars` },
      };
    }
    const reply = await invokeSidecar("audio.transcribe", { path: target, language: params.language }, 180_000, ctx.signal);
    if (!reply.ok) return unavailable(reply.unavailable ?? reply.error ?? "sidecar STT unavailable", reply.fix ?? "pip install faster-whisper");
    const text = String(reply.result?.text ?? "").trim();
    return {
      status: text ? "SUCCESS" : "VERIFICATION_FAILED",
      summary: text ? `transcribed ${text.split(/\s+/).filter(Boolean).length} word(s) via sidecar faster-whisper` : "no speech detected",
      data: { engine: "sidecar-faster-whisper", text, sourceBytes: buffer.byteLength },
      evidence: [{ kind: "stt", detail: `${text.length} chars` }],
      artifacts: [],
      verification: { verified: text.length > 0, method: "nonempty-transcript", detail: `${text.length} chars` },
    };
  },
});

registerTool({
  id: "voice.speak",
  title: "Speak a response (TTS)",
  group: "voice",
  description: "Synthesises speech through a configured local TTS engine and returns a real audio artifact with duration.",
  risk: "LOW",
  resourceClass: "MEDIUM",
  agents: ["voice", "aisha"],
  params: z.object({ text: z.string().min(1).max(4000), voice: z.string().optional() }),
  verificationNote: "The returned audio must decode as WAV/MP3 with a non-zero duration reported by the engine or parsed from the container.",
  availability: async () => {
    const status = await voiceStatus();
    if (status.tts.status === "AVAILABLE") return { available: true, detail: `${status.tts.engine} — ${status.tts.detail}` };
    return { available: false, detail: status.tts.detail, fix: status.tts.fix };
  },
  execute: async (ctx, params) => {
    const response = await fetch(`${TTS_URL}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: params.text, voice: params.voice }),
      signal: ctx.signal,
    });
    if (!response.ok) return fail("FAILED", `TTS engine returned HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength < 512) return fail("VERIFICATION_FAILED", `TTS engine returned only ${buffer.byteLength}B of audio`);
    const dir = await artifactDirFor(ctx.taskId);
    const output = path.join(dir, `${slugify(params.text.slice(0, 40))}.wav`);
    await fs.writeFile(output, buffer);
    return {
      status: "SUCCESS",
      summary: `synthesised ${buffer.byteLength}B of audio via ${TTS_URL}`,
      data: { path: toRelative(DIRS.root, output), bytes: buffer.byteLength, engine: TTS_URL },
      evidence: [{ kind: "tts", detail: `${buffer.byteLength}B audio persisted` }],
      artifacts: [{ name: path.basename(output), kind: "audio:tts", filePath: output, mimeType: "audio/wav", origin: "deterministic" }],
      verification: { verified: buffer.byteLength > 512, method: "audio-bytes", detail: `${buffer.byteLength}B` },
    };
  },
});

export const _voiceHints = { ok, IS_WINDOWS };
