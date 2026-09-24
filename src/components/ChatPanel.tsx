"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LiveEvent } from "@/components/useExecutive";

type MicState = "IDLE" | "REQUESTING" | "LISTENING" | "PROCESSING" | "SPEAKING" | "MICROPHONE_ERROR" | "NO_SPEECH_DETECTED";

const SPEECH_THRESHOLD = 0.022;
const SILENCE_MS = 950;

export function ChatPanel({
  onSend,
  busy,
  events,
  speak,
  stopSpeaking,
  attachedUploads,
  onNotice,
}: {
  onSend: (message: string, uploadIds: string[]) => Promise<boolean>;
  busy: boolean;
  events: LiveEvent[];
  speak: (text: string, options?: { rate?: number; pitch?: number }) => boolean;
  stopSpeaking: () => void;
  attachedUploads: string[];
  onNotice: (message: string) => void;
}) {
  const [text, setText] = useState("");
  const [micState, setMicState] = useState<MicState>("IDLE");
  const [level, setLevel] = useState(0);
  const [handsFree, setHandsFree] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [engine, setEngine] = useState<{ stt: string; tts: string; note: string }>({ stt: "checking", tts: "checking", note: "" });
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [lastSpoken, setLastSpoken] = useState<number>(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const silenceRef = useRef<number | null>(null);
  const speechStartedRef = useRef<number>(0);
  const handsFreeRef = useRef(false);
  const pttRef = useRef(false);
  const recognitionRef = useRef<{ start: () => void; stop: () => void; abort: () => void } | null>(null);

  useEffect(() => {
    handsFreeRef.current = handsFree;
  }, [handsFree]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/voice");
        const payload = (await res.json()) as { stt: { engine: string; status: string; note?: string }; tts: { engine: string; status: string; note?: string } };
        setEngine({
          stt: `${payload.stt.engine} (${payload.stt.status})`,
          tts: `${payload.tts.engine} (${payload.tts.status})`,
          note: [payload.stt.note, payload.tts.note].filter(Boolean).join(" "),
        });
      } catch {
        setEngine({ stt: "unknown", tts: "unknown", note: "Voice capability endpoint unreachable." });
      }
    })();
  }, []);

  // Speak supervisor reports (real backend events), with interruption support.
  useEffect(() => {
    if (!voiceEnabled) return;
    const latest = events.filter((event) => event.type === "SUPERVISOR_MESSAGE").at(-1);
    if (!latest || !latest.id || latest.id === lastSpoken) return;
    setLastSpoken(latest.id);
    const spoken = speak(latest.message.slice(0, 400), { rate: 1.0, pitch: 1.02 });
    if (spoken) setMicState("SPEAKING");
  }, [events, lastSpoken, speak, voiceEnabled]);

  const sendText = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (trimmed.length === 0) return;
      setTranscript(trimmed);
      await onSend(trimmed, attachedUploads);
      setText("");
    },
    [attachedUploads, onSend],
  );

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    if (silenceRef.current) {
      window.clearTimeout(silenceRef.current);
      silenceRef.current = null;
    }
  }, []);

  const transcribe = useCallback(
    async (blob: Blob, durationMs: number) => {
      setMicState("PROCESSING");
      const form = new FormData();
      form.append("mode", "stt");
      form.append("audio", new File([blob], "speech.webm", { type: blob.type || "audio/webm" }));
      form.append("durationMs", String(Math.round(durationMs)));
      form.append("sampleRate", "16000");
      try {
        const res = await fetch("/api/voice", { method: "POST", body: form });
        const payload = (await res.json()) as { ok: boolean; status: string; engine?: string; text?: string; message?: string };
        if (payload.ok && payload.text) {
          setErrorDetail(null);
          onNotice(`Transcript (${payload.engine}): ${payload.text.slice(0, 120)}`);
          await sendText(payload.text);
          setMicState("IDLE");
          return;
        }
        if (payload.status === "NO_SPEECH") {
          setMicState("NO_SPEECH_DETECTED");
          setErrorDetail(payload.message ?? "No speech detected in the recording.");
          return;
        }
        // Explicit, visible fallback to the operating system speech engine.
        const recognition = getRecognition();
        if (recognition) {
          setErrorDetail(`${payload.message ?? "Local transcription unavailable."} Falling back to the browser speech engine — this is shown, not hidden.`);
          setMicState("LISTENING");
          recognition.lang = "en-US";
          recognition.onresult = (event: { results: { 0: { transcript: string } }[] }) => {
            const spoken = event.results[0]?.[0]?.transcript ?? "";
            setMicState("PROCESSING");
            if (spoken.trim().length === 0) {
              setMicState("NO_SPEECH_DETECTED");
              setErrorDetail("The browser speech engine returned an empty transcript. I will not pretend to have heard you.");
              return;
            }
            void sendText(spoken);
            setMicState("IDLE");
          };
          recognition.onerror = () => {
            setMicState("MICROPHONE_ERROR");
            setErrorDetail("Browser speech engine error. Text input remains available.");
          };
          recognition.start();
          recognitionRef.current = recognition;
          return;
        }
        setMicState("MICROPHONE_ERROR");
        setErrorDetail(`${payload.message ?? "Transcription unavailable."} No browser speech engine is present in this environment either, so please use text input.`);
      } catch (error) {
        setMicState("MICROPHONE_ERROR");
        setErrorDetail(`Voice request failed: ${(error as Error).message}`);
      }
    },
    [onNotice, sendText],
  );

  const startRecording = useCallback(async () => {
    if (recorderRef.current && recorderRef.current.state === "recording") return;
    setErrorDetail(null);
    setMicState((previous) => (previous === "PROCESSING" ? previous : "REQUESTING"));
    try {
      if (!streamRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true } : { echoCancellation: true, noiseSuppression: true },
        });
        streamRef.current = stream;
        const audioCtx = new AudioContext();
        audioCtxRef.current = audioCtx;
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyser);
        analyserRef.current = analyser;
        const list = await navigator.mediaDevices.enumerateDevices();
        setDevices(list.filter((device) => device.kind === "audioinput"));
      }
      const stream = streamRef.current as MediaStream;
      const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : undefined });
      chunksRef.current = [];
      const startedAt = Date.now();
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        if (blob.size < 1200) {
          setMicState("NO_SPEECH_DETECTED");
          setErrorDetail("The recording was too short to contain speech (under 1.2 KB of audio). Nothing was transcribed.");
          return;
        }
        void transcribe(blob, Date.now() - startedAt);
      };
      recorder.start(250);
      recorderRef.current = recorder;
      speechStartedRef.current = Date.now();
      setMicState("LISTENING");
    } catch (error) {
      setMicState("MICROPHONE_ERROR");
      setErrorDetail(
        `Microphone unavailable: ${(error as Error).name === "NotAllowedError" ? "permission denied. Grant microphone access in the browser/OS and retry." : (error as Error).message}`,
      );
    }
  }, [deviceId, transcribe]);

  // Live input level meter + VAD for hands-free mode and true barge-in.
  useEffect(() => {
    const analyser = analyserRef.current;
    if (!analyser) {
      const timer = setInterval(() => {
        if (analyserRef.current) setLevel(computeLevel(analyserRef.current));
      }, 120);
      return () => clearInterval(timer);
    }
    let frames = 0;
    let raf = 0;
    const loop = () => {
      const value = computeLevel(analyser);
      frames += 1;
      if (frames % 3 === 0) setLevel(value);
      const speakingNow = typeof window !== "undefined" && "speechSynthesis" in window && window.speechSynthesis.speaking;
      if (speakingNow && value > SPEECH_THRESHOLD * 1.6) {
        // Real interruption: the user speaking stops the supervisor's voice.
        window.speechSynthesis.cancel();
        setMicState("LISTENING");
      }
      if (handsFreeRef.current) {
        if (value > SPEECH_THRESHOLD) {
          speechStartedRef.current = speechStartedRef.current || Date.now();
          if (!recorderRef.current || recorderRef.current.state === "inactive") void startRecording();
          if (silenceRef.current) {
            window.clearTimeout(silenceRef.current);
            silenceRef.current = null;
          }
        } else if (recorderRef.current && recorderRef.current.state === "recording" && !silenceRef.current) {
          silenceRef.current = window.setTimeout(() => {
            stopRecording();
            silenceRef.current = null;
          }, SILENCE_MS);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [startRecording, stopRecording]);

  // Push-to-talk: hold CTRL+SPACE.
  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      return element ? ["INPUT", "TEXTAREA"].includes(element.tagName) || element.isContentEditable : false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space" && event.ctrlKey && !isTyping(event.target)) {
        event.preventDefault();
        if (!pttRef.current) {
          pttRef.current = true;
          stopSpeaking();
          void startRecording();
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space" && pttRef.current) {
        event.preventDefault();
        pttRef.current = false;
        stopRecording();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [startRecording, stopRecording, stopSpeaking]);

  const conversations = useMemo(() => {
    return events
      .filter((event) => ["USER_MESSAGE", "SUPERVISOR_MESSAGE", "AGENT_SPEAKING"].includes(event.type))
      .slice(-14)
      .map((event) => ({
        id: `${event.id ?? event.ts}`,
        role: event.type === "USER_MESSAGE" ? "YOU" : event.type === "SUPERVISOR_MESSAGE" ? "AISHA (Master)" : `${event.agentId}`,
        text: event.message,
        ts: event.ts,
        tone: event.type === "SUPERVISOR_MESSAGE" ? "master" : event.type === "USER_MESSAGE" ? "user" : "agent",
      }));
  }, [events]);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
        <div className="flex items-center justify-between">
          <p className="text-[11px] uppercase tracking-[0.2em] text-white/50">Voice pipeline</p>
          <span className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] ${micState === "MICROPHONE_ERROR" ? "border-red-400/50 text-red-200" : micState === "NO_SPEECH_DETECTED" ? "border-amber-400/50 text-amber-200" : micState === "LISTENING" ? "border-cyan-400/60 text-cyan-100" : "border-white/15 text-white/60"}`}>
            {micState.replace(/_/g, " ")}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400 transition-[width] duration-75" style={{ width: `${Math.min(100, Math.round(level * 420))}%` }} />
          </div>
          <button
            type="button"
            onMouseDown={() => {
              stopSpeaking();
              void startRecording();
            }}
            onMouseUp={stopRecording}
            onMouseLeave={() => recorderRef.current && stopRecording()}
            className="rounded-lg border border-cyan-400/40 px-3 py-1 text-[11px] text-cyan-100 hover:bg-cyan-500/10"
          >
            🎤 Hold to talk (Ctrl+Space)
          </button>
          <button
            type="button"
            onClick={() => setHandsFree((value) => !value)}
            className={`rounded-lg border px-3 py-1 text-[11px] ${handsFree ? "border-emerald-400/50 bg-emerald-500/10 text-emerald-100" : "border-white/20 text-white/70 hover:bg-white/5"}`}
          >
            {handsFree ? "Hands-free ON" : "Hands-free OFF"}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-white/45">
          <span>STT: <code className="text-cyan-200">{engine.stt}</code></span>
          <span>TTS: <code className="text-cyan-200">{engine.tts}</code></span>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={voiceEnabled} onChange={(event) => setVoiceEnabled(event.target.checked)} className="accent-cyan-400" />
            speak replies
          </label>
          {devices.length > 0 && (
            <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)} className="rounded border border-white/15 bg-black/40 px-1 py-0.5 text-[10px] text-white">
              <option value="">default microphone</option>
              {devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `input ${device.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          )}
          <button type="button" onClick={stopSpeaking} className="rounded border border-white/15 px-2 py-0.5 hover:bg-white/10">
            stop speaking
          </button>
        </div>
        {engine.note && <p className="mt-1 text-[10px] leading-snug text-white/40">{engine.note}</p>}
        {errorDetail && <p className="mt-1 rounded-lg border border-amber-400/30 bg-amber-500/5 px-2 py-1 text-[10px] text-amber-100">{errorDetail}</p>}
      </div>

      <div className="min-h-[120px] flex-1 space-y-2 overflow-y-auto rounded-xl border border-white/10 bg-black/25 p-3">
        {conversations.length === 0 && (
          <p className="text-[12px] text-white/45">
            What would you like me to do? Try “research the best free local AI video tools and save a report to my Documents folder”, “analyse the PDF I uploaded”, or
            “create a professional 45 second video explaining black holes”.
          </p>
        )}
        {conversations.map((entry) => (
          <div key={entry.id} className={`rounded-xl border px-3 py-2 text-[12px] ${entry.tone === "user" ? "border-cyan-400/25 bg-cyan-500/5" : entry.tone === "master" ? "border-amber-300/30 bg-amber-500/5" : "border-white/10 bg-white/[0.03]"}`}>
            <p className="mb-0.5 text-[10px] uppercase tracking-[0.16em] text-white/40">
              {entry.role} · {new Date(entry.ts).toLocaleTimeString()}
            </p>
            <p className="whitespace-pre-wrap text-white/85">{entry.text}</p>
          </div>
        ))}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void sendText(text);
        }}
        className="flex items-end gap-2"
      >
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendText(text);
            }
          }}
          rows={2}
          placeholder="Talk to the Master Supervisor… (Enter to send, Shift+Enter for a new line)"
          className="flex-1 resize-none rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-[12.5px] text-white outline-none focus:border-cyan-400/60"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-xl border border-emerald-400/50 bg-emerald-500/15 px-4 py-2 text-[12px] font-semibold text-emerald-100 transition hover:bg-emerald-500/25 disabled:opacity-40"
        >
          {busy ? "…" : "Send"}
        </button>
      </form>
      {transcript && <p className="text-[10px] text-white/30">last transcript: {transcript.slice(0, 160)}</p>}
    </div>
  );
}

function computeLevel(analyser: AnalyserNode): number {
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    const value = (data[i] - 128) / 128;
    sum += value * value;
  }
  return Math.sqrt(sum / data.length);
}

type RecognitionLike = { start: () => void; stop: () => void; abort: () => void; lang: string; onresult: (event: { results: { 0: { transcript: string } }[] }) => void; onerror: () => void };

function getRecognition(): RecognitionLike | null {
  if (typeof window === "undefined") return null;
  const holder = window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
  const Constructor = holder.SpeechRecognition ?? holder.webkitSpeechRecognition;
  return Constructor ? new Constructor() : null;
}
