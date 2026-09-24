/**
 * Ollama provider — local-first reasoning with honest unavailability.
 * Model discovery is live; no model name is hard-coded into task logic.
 */
import { OLLAMA_TIMEOUT_MS, OLLAMA_URL } from "@/lib/config";
import { errorMessage } from "@/lib/util";

export const OLLAMA_MODEL_ENV = "OLLAMA_MODEL";

export type OllamaModel = { name: string; sizeBytes: number; parameterSize: string; family: string; modifiedAt: string };

export type OllamaStatus = {
  status: "AVAILABLE" | "UNAVAILABLE" | "MISCONFIGURED" | "FAILED";
  url: string;
  models: OllamaModel[];
  selectedModel: string | null;
  selectionReason: string;
  detail: string;
  latencyMs: number;
};

export async function listModels(timeoutMs = 3000): Promise<{ models: OllamaModel[]; detail: string; ok: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) return { models: [], detail: `HTTP ${response.status} from ${OLLAMA_URL}/api/tags`, ok: false };
    const body = (await response.json()) as {
      models?: Array<{ name: string; size?: number; details?: { parameter_size?: string; family?: string }; modified_at?: string }>;
    };
    const models = (body.models ?? []).map((m) => ({
      name: m.name,
      sizeBytes: m.size ?? 0,
      parameterSize: m.details?.parameter_size ?? "unknown",
      family: m.details?.family ?? "unknown",
      modifiedAt: m.modified_at ?? "",
    }));
    return { models, detail: `${models.length} model(s) in ${Date.now() - started}ms`, ok: true };
  } catch (error) {
    return { models: [], detail: `unreachable: ${errorMessage(error)}`, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Prefers the configured model, else the lightest local model that fits the box. */
export async function probe(): Promise<OllamaStatus> {
  const started = Date.now();
  const { models, detail, ok } = await listModels();
  if (!ok) {
    return {
      status: "UNAVAILABLE",
      url: OLLAMA_URL,
      models: [],
      selectedModel: null,
      selectionReason: "no live Ollama endpoint",
      detail,
      latencyMs: Date.now() - started,
    };
  }
  const configured = process.env[OLLAMA_MODEL_ENV];
  let selected: OllamaModel | undefined;
  let reason: string;
  if (configured && models.some((m) => m.name === configured)) {
    selected = models.find((m) => m.name === configured);
    reason = `${OLLAMA_MODEL_ENV}=${configured} is installed`;
  } else if (configured) {
    selected = models[0];
    reason = `${OLLAMA_MODEL_ENV}=${configured} is NOT installed; falling back to discovered ${selected?.name ?? "none"}`;
  } else {
    const sorted = [...models].sort((a, b) => a.sizeBytes - b.sizeBytes);
    selected = sorted.find((m) => /(3b|7b|8b|instruct|llama|qwen|mistral|phi)/i.test(m.name)) ?? sorted[0];
    reason = selected
      ? `no ${OLLAMA_MODEL_ENV} set; discovered ${models.length} model(s), selected smallest capable: ${selected.name} (${selected.parameterSize})`
      : "no models installed (Ollama is running but has no weights)";
  }
  return {
    status: selected ? "AVAILABLE" : "MISCONFIGURED",
    url: OLLAMA_URL,
    models,
    selectedModel: selected?.name ?? null,
    selectionReason: reason,
    detail,
    latencyMs: Date.now() - started,
  };
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatResult = {
  ok: boolean;
  content: string;
  model: string;
  ms: number;
  promptEvalCount?: number;
  evalCount?: number;
  detail: string;
};

export async function chat(
  messages: ChatMessage[],
  opts: { model?: string | null; json?: boolean; signal?: AbortSignal; timeoutMs?: number; temperature?: number } = {},
): Promise<ChatResult> {
  const status = opts.model ? null : await probe();
  const model = opts.model ?? status?.selectedModel ?? null;
  const started = Date.now();
  if (!model) {
    return { ok: false, content: "", model: "none", ms: 0, detail: "no Ollama model available" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? OLLAMA_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        format: opts.json ? "json" : undefined,
        options: { temperature: opts.temperature ?? 0.2 },
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      return { ok: false, content: "", model, ms: Date.now() - started, detail: `HTTP ${response.status}: ${(await response.text()).slice(0, 400)}` };
    }
    const body = (await response.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    return {
      ok: true,
      content: body.message?.content ?? "",
      model,
      ms: Date.now() - started,
      promptEvalCount: body.prompt_eval_count,
      evalCount: body.eval_count,
      detail: "ok",
    };
  } catch (error) {
    return { ok: false, content: "", model, ms: Date.now() - started, detail: errorMessage(error) };
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
