import { writeLogFile } from "@/lib/logging";

/**
 * LLM access is explicit and single-tier: Ollama (local) first, an optional
 * cloud provider only when the user has both provided a key AND set
 * AI_EXECUTIVE_ENABLE_CLOUD_LLM=true. There is no silent fallback chain — if
 * the configured engine fails, the caller is told and uses the deterministic
 * local planner instead, and the UI shows which engine actually answered.
 */

export type LlmEngine = "ollama" | "openai" | "anthropic" | "groq" | "openrouter" | "none";

export type LlmAttempt = {
  ok: boolean;
  text: string;
  engine: LlmEngine;
  model?: string;
  error?: string;
  latencyMs: number;
};

const OLLAMA_DEFAULT = "http://127.0.0.1:11434";

async function ollamaGenerate(prompt: string, system: string, signal?: AbortSignal, timeoutMs = 90000): Promise<LlmAttempt> {
  const base = process.env.OLLAMA_URL ?? OLLAMA_DEFAULT;
  const model = process.env.OLLAMA_MODEL ?? "llama3.1:8b";
  const started = Date.now();
  try {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, system, stream: false, options: { temperature: 0.4 } }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (!res.ok) {
      return { ok: false, text: "", engine: "ollama", model, error: `HTTP ${res.status} from Ollama`, latencyMs: Date.now() - started };
    }
    const payload = (await res.json()) as { response?: string };
    return { ok: true, text: payload.response ?? "", engine: "ollama", model, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, text: "", engine: "ollama", model, error: (error as Error).message, latencyMs: Date.now() - started };
  }
}

async function openAiCompatible(
  prompt: string,
  system: string,
  options: { url: string; key: string; model: string; engine: LlmEngine; signal?: AbortSignal; timeoutMs?: number },
): Promise<LlmAttempt> {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 90000);
    const res = await fetch(options.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.key}` },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        temperature: 0.4,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (!res.ok) return { ok: false, text: "", engine: options.engine, model: options.model, error: `HTTP ${res.status}`, latencyMs: Date.now() - started };
    const payload = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return { ok: true, text: payload.choices?.[0]?.message?.content ?? "", engine: options.engine, model: options.model, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, text: "", engine: options.engine, model: options.model, error: (error as Error).message, latencyMs: Date.now() - started };
  }
}

/** Ask the configured model. Never throws; failure is reported, not hidden. */
export async function askModel(prompt: string, system: string, signal?: AbortSignal): Promise<LlmAttempt> {
  const ollama = await ollamaGenerate(prompt, system, signal);
  if (ollama.ok && ollama.text.trim().length > 0) return ollama;

  const cloudEnabled = process.env.AI_EXECUTIVE_ENABLE_CLOUD_LLM === "true";
  if (cloudEnabled) {
    if (process.env.OPENAI_API_KEY) {
      const attempt = await openAiCompatible(prompt, system, {
        url: "https://api.openai.com/v1/chat/completions",
        key: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        engine: "openai",
        signal,
      });
      if (attempt.ok && attempt.text.trim().length > 0) return attempt;
    }
    if (process.env.GROQ_API_KEY) {
      const attempt = await openAiCompatible(prompt, system, {
        url: "https://api.groq.com/openai/v1/chat/completions",
        key: process.env.GROQ_API_KEY,
        model: process.env.GROQ_MODEL ?? "llama-3.1-8b-instant",
        engine: "groq",
        signal,
      });
      if (attempt.ok && attempt.text.trim().length > 0) return attempt;
    }
  }

  writeLogFile("agents", "warn", `No LLM produced an answer (${ollama.error ?? "ollama unreachable"}). Deterministic local engine takes over.`);
  return { ok: false, text: "", engine: "none", error: ollama.error ?? "No configured LLM answered", latencyMs: ollama.latencyMs };
}
