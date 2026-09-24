import { emit } from "@/lib/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Voice pipeline endpoint. Speech-to-text prefers a real local faster-whisper
 * server (WHISPER_URL) and speech synthesis prefers a local TTS server
 * (TTS_URL). When neither is configured the endpoint answers with an explicit
 * DISABLED status and the renderer falls back to the operating system speech
 * engines — the UI always shows which engine produced the transcript or voice,
 * and the app never claims to have heard speech that was not detected.
 */
export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const mode = String(form.get("mode") ?? "stt");
    if (mode === "tts") {
      const text = String(form.get("text") ?? "");
      const voice = String(form.get("voice") ?? "default");
      const ttsUrl = process.env.TTS_URL;
      if (!ttsUrl) {
        return Response.json({ ok: false, status: "DISABLED", engine: "browser-speech-synthesis", message: "TTS_URL is not configured. The renderer will use the operating system speech engine instead; this is reported in the UI." }, { status: 503 });
      }
      try {
        const res = await fetch(`${ttsUrl.replace(/\/$/, "")}/tts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, voice, format: "wav" }),
        });
        if (!res.ok) return Response.json({ ok: false, status: "ERROR", engine: "local-tts-server", message: `Local TTS server answered HTTP ${res.status}.` }, { status: 502 });
        const buffer = Buffer.from(await res.arrayBuffer());
        return new Response(new Uint8Array(buffer), { headers: { "content-type": "audio/wav", "x-tts-engine": "local-tts-server" } });
      } catch (error) {
        return Response.json({ ok: false, status: "ERROR", engine: "local-tts-server", message: `Local TTS server unreachable: ${(error as Error).message}` }, { status: 502 });
      }
    }

    const audio = form.get("audio");
    if (!(audio instanceof File)) {
      return Response.json({ ok: false, status: "ERROR", message: "No audio part received (expected field name 'audio')." }, { status: 400 });
    }
    const buffer = Buffer.from(await audio.arrayBuffer());
    const sampleRate = form.get("sampleRate") ? Number(form.get("sampleRate")) : null;
    const durationMs = form.get("durationMs") ? Number(form.get("durationMs")) : null;
    const whisperUrl = process.env.WHISPER_URL;
    await emit({
      ts: new Date().toISOString(),
      agentId: "voice_agent",
      type: "AGENT_STATE",
      message: `Microphone capture received: ${buffer.byteLength} bytes${durationMs ? ` over ${(durationMs / 1000).toFixed(1)}s` : ""}${sampleRate ? ` @ ${sampleRate} Hz` : ""}.`,
      data: { state: "LISTENING", bytes: buffer.byteLength, durationMs, sampleRate },
    });
    if (!whisperUrl) {
      return Response.json(
        {
          ok: false,
          status: "DISABLED",
          engine: null,
          bytes: buffer.byteLength,
          message: "WHISPER_URL is not configured, so the local faster-whisper server could not transcribe this audio. Use the browser speech engine fallback (shown in the UI) or configure a local Whisper server. No transcript was invented.",
        },
        { status: 503 },
      );
    }
    try {
      const res = await fetch(`${whisperUrl.replace(/\/$/, "")}/transcribe`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-filename": audio.name || "speech.webm", "x-sample-rate": String(sampleRate ?? 16000) },
        body: new Uint8Array(buffer),
      });
      if (!res.ok) return Response.json({ ok: false, status: "ERROR", engine: "faster-whisper", message: `Whisper server answered HTTP ${res.status}.` }, { status: 502 });
      const payload = (await res.json()) as { text?: string; transcript?: string; words?: { word: string; start: number; end: number }[]; language?: string; duration?: number };
      const text = (payload.text ?? payload.transcript ?? "").trim();
      if (text.length === 0) {
        return Response.json({ ok: false, status: "NO_SPEECH", engine: "faster-whisper", message: "The local Whisper server detected no speech in this recording. I will not pretend to have heard you." }, { status: 200 });
      }
      return Response.json({ ok: true, status: "OK", engine: "faster-whisper", text, words: payload.words ?? [], language: payload.language ?? null, durationMs: payload.duration ? payload.duration * 1000 : durationMs, bytes: buffer.byteLength });
    } catch (error) {
      return Response.json({ ok: false, status: "ERROR", engine: "faster-whisper", message: `Whisper server unreachable: ${(error as Error).message}` }, { status: 502 });
    }
  }

  const ttsUrl = process.env.TTS_URL;
  const whisperUrl = process.env.WHISPER_URL;
  return Response.json({
    ok: true,
    stt: whisperUrl
      ? { engine: "faster-whisper", status: "CONFIGURED", endpoint: whisperUrl }
      : { engine: "browser-speech-recognition", status: "FALLBACK", note: "No local Whisper server configured; the renderer uses the operating system engine and labels it as such." },
    tts: ttsUrl
      ? { engine: "local-tts-server", status: "CONFIGURED", endpoint: ttsUrl }
      : { engine: "browser-speech-synthesis", status: "FALLBACK", note: "No local TTS server configured. Narration is spoken in the interface but is not burned into rendered files." },
  });
}
