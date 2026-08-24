/**
 * Vercel AI Gateway provider implementation (models only).
 *
 * See docs/providers/vercel.md for the endpoint contract, response shape,
 * and mapping rules.
 *
 * - `VercelModelObtainer` — `GET /v1/models` (public; Bearer key optional).
 *
 * The Vercel AI Gateway exposes **no benchmark feed**. Wiring the gateway into
 * `anypick()` pairs this obtainer with `NoopBenchmarkObtainer`; only price-only
 * strategies (`cheapest`) are meaningful against it.
 */

import { f, get, request } from "./http.js";
import { Model } from "./model.js";
import type { ListModelsOptions } from "./obtainer.js";

export const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v1";

// Capability tag -> input modality it implies. Vercel's `tags` array is the
// only capability signal on the list-models payload; language models accept
// `text` by default. See docs/providers/vercel.md §"Capability derivation".
const TAG_TO_INPUT_MODALITY: Record<string, string> = {
  vision: "image",
  "file-input": "file",
  "audio-input": "audio",
};

// `type` -> default output modality.
const TYPE_TO_OUTPUT_MODALITY: Record<string, string> = {
  language: "text",
  image: "image",
  video: "video",
};

/**
 * List models from the Vercel AI Gateway `/v1/models` endpoint.
 *
 * The endpoint is public (no auth) but accepts an optional
 * `Authorization: Bearer <key>` (an AI Gateway API key), which raises the
 * unauthenticated rate ceiling. Pass `apiKey` or set
 * `VERCEL_AI_GATEWAY_API_KEY`.
 */
export class VercelModelObtainer {
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly timeoutMs: number;

  constructor(opts: {
    baseUrl?: string;
    apiKey?: string | null;
    timeoutMs?: number;
  } = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? process.env["VERCEL_AI_GATEWAY_API_KEY"] ?? null;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async listModels(_opts: ListModelsOptions = {}): Promise<Model[]> {
    const url = `${this.baseUrl}/models`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const resp = (await request("GET", url, {
      headers,
      timeoutMs: this.timeoutMs,
    })) as { data?: unknown };
    const data = Array.isArray(resp?.data) ? resp.data : [];
    return (data as Record<string, unknown>[]).map(mapModel);
  }
}

export function mapModel(item: Record<string, unknown>): Model {
  const pricing = (get(item, "pricing", {}) as Record<string, unknown>) ?? {};
  const tags = ((get(item, "tags", []) as unknown[]) ?? []).map(String);
  const modelType = String(item["type"] ?? "language");

  // Input modalities: language models always accept text; tags add the rest.
  const inputModalities: string[] = [];
  if (["language", "embedding", "reranking", "image", "video"].includes(modelType)) {
    inputModalities.push("text");
  }
  for (const tag of tags) {
    const modality = TAG_TO_INPUT_MODALITY[tag];
    if (modality && !inputModalities.includes(modality)) {
      inputModalities.push(modality);
    }
  }

  // Output modalities: derived from `type`. Embedding/reranking -> [] (vectors
  // aren't a chat modality).
  const outputModality = TYPE_TO_OUTPUT_MODALITY[modelType];
  const outputModalities: string[] = outputModality ? [outputModality] : [];

  return new Model({
    id: String(item["id"] ?? ""),
    name: String(item["name"] ?? item["id"] ?? ""),
    contextLength: Number(get(item, "context_window", 0) ?? 0),
    inputModalities,
    outputModalities,
    promptPrice: f(pricing["input"]),
    completionPrice: f(pricing["output"]),
    cacheReadPrice: f(pricing["input_cache_read"]),
    supportsTools: tags.includes("tool-use"),
    supportsReasoning: tags.includes("reasoning"),
    // Vercel's list-models payload has no structured-output signal; this stays
    // false (unknown) until the per-model endpoints endpoint is used.
    supportsStructuredOutputs: false,
    raw: item,
  });
}
