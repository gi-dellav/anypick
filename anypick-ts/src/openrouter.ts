/**
 * OpenRouter provider implementations.
 *
 * See docs/providers/openrouter.md for the endpoint contracts, response
 * shapes, and mapping rules.
 *
 * - `OpenRouterModelObtainer` — `GET /api/v1/models` (no auth).
 * - `OpenRouterBenchmarkObtainer` — `GET /api/v1/benchmarks` (key required,
 *   rate-limited 30/min·500/day).
 */

import { BadAuth, ProviderError, RateLimited } from "./errors.js";
import { f, get, request } from "./http.js";
import { BenchmarkScore, Model } from "./model.js";
import type { ListBenchmarksOptions, ListModelsOptions } from "./obtainer.js";

export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

// artificial-analysis task_type -> index field on the item
const AA_INDEX_FIELDS: Record<string, string> = {
  coding: "coding_index",
  intelligence: "intelligence_index",
  agentic: "agentic_index",
};

// design-arena: the API narrows by `arena`/`category`. OpenRouter does not
// publish a fixed response shape for this source, so the mapper is defensive.
const DA_SCORE_FIELDS = ["score", "elo", "arena_elo", "category_score"];

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** List models from OpenRouter's public `/models` endpoint. */
export class OpenRouterModelObtainer {
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly timeoutMs: number;

  constructor(opts: {
    baseUrl?: string;
    apiKey?: string | null;
    timeoutMs?: number;
  } = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? null;
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
  const arch = (get(item, "architecture", {}) as Record<string, unknown>) ?? {};
  const supported = (get(item, "supported_parameters", []) as unknown[]) ?? [];
  return new Model({
    id: String(item["id"] ?? ""),
    name: String(item["name"] ?? item["id"] ?? ""),
    contextLength: Number(get(item, "context_length", 0) ?? 0),
    inputModalities: ((get(arch, "input_modalities", []) as unknown[]) ?? []).map(String),
    outputModalities: ((get(arch, "output_modalities", []) as unknown[]) ?? []).map(String),
    promptPrice: f(pricing["prompt"]),
    completionPrice: f(pricing["completion"]),
    cacheReadPrice: f(pricing["input_cache_read"]),
    supportsTools: supported.includes("tools"),
    supportsReasoning: supported.includes("reasoning"),
    supportsStructuredOutputs: supported.includes("structured_outputs"),
    raw: item,
  });
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

/**
 * List benchmarks from OpenRouter's `/benchmarks` endpoint.
 *
 * Requires an API key (read `OPENROUTER_API_KEY` if not passed). Rate-limited
 * to 30 req/min per key and 500 req/day per account; a 429 triggers exponential
 * backoff before surfacing `RateLimited`.
 */
export class OpenRouterBenchmarkObtainer {
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly timeoutMs: number;
  readonly maxRetries: number;

  constructor(opts: {
    apiKey?: string | null;
    baseUrl?: string;
    timeoutMs?: number;
    maxRetries?: number;
  } = {}) {
    this.apiKey = opts.apiKey ?? process.env["OPENROUTER_API_KEY"] ?? null;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  async listBenchmarks(opts: ListBenchmarksOptions = {}): Promise<BenchmarkScore[]> {
    if (!this.apiKey) {
      throw new BadAuth(
        "OpenRouter benchmarks require an API key (set OPENROUTER_API_KEY or pass apiKey).",
      );
    }

    const url = `${this.baseUrl}/benchmarks`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    // Server-side query params per the /benchmarks OpenAPI:
    //   source, task_type, arena, category, max_results
    // NOTE: `benchmark_type` is *not* a server query param — it is a response
    // field on `openrouter`-source items. We narrow on it client-side below to
    // honor the interface's narrowing hint.
    const params: Record<string, string> = {};
    if (opts.source) params["source"] = opts.source;
    if (opts.taskType) params["task_type"] = opts.taskType;
    if (opts.arena) params["arena"] = String(opts.arena);
    if (opts.category) params["category"] = String(opts.category);
    if (opts.maxResults !== undefined) params["max_results"] = String(opts.maxResults);

    const resp = (await request("GET", url, {
      headers,
      params,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
    })) as { data?: unknown };
    const data = Array.isArray(resp?.data) ? resp.data : [];
    const taskType = opts.taskType ?? null;
    let scores = (data as Record<string, unknown>[]).map((item) =>
      mapBenchmark(item, taskType),
    );
    if (opts.benchmarkType) {
      scores = scores.filter((s) => s.benchmarkType === opts.benchmarkType);
    }
    return scores;
  }
}

export function mapBenchmark(
  item: Record<string, unknown>,
  requestedTaskType: string | null,
): BenchmarkScore {
  const src = String(item["source"] ?? "");
  const modelId = String(item["model_permaslug"] ?? "");

  if (src === "artificial-analysis") {
    const field =
      AA_INDEX_FIELDS[requestedTaskType ?? ""] ?? "intelligence_index";
    return new BenchmarkScore({
      modelId,
      source: "artificial-analysis",
      taskType: requestedTaskType,
      benchmarkType: null,
      score: f(item[field]),
      accuracy: null,
      stddev: null,
      raw: item,
    });
  }

  if (src === "openrouter") {
    const accuracy = item["accuracy"];
    const stddev = item["accuracy_stddev"];
    return new BenchmarkScore({
      modelId,
      source: "openrouter",
      taskType: null,
      benchmarkType:
        item["benchmark_type"] !== undefined && item["benchmark_type"] !== null
          ? String(item["benchmark_type"])
          : null,
      score: f(item["accuracy"]),
      accuracy: accuracy !== undefined && accuracy !== null ? f(accuracy) : null,
      stddev: stddev !== undefined && stddev !== null ? f(stddev) : null,
      raw: item,
    });
  }

  if (src === "design-arena") {
    // OpenRouter doesn't publish a fixed design-arena item shape. Narrowing
    // happens server-side via `arena`/`category` query params; here we record
    // the category under `benchmarkType` and pick the first numeric score field.
    const category =
      item["category"] !== undefined && item["category"] !== null
        ? String(item["category"])
        : null;
    let score = 0.0;
    for (const field of DA_SCORE_FIELDS) {
      if (item[field] !== undefined && item[field] !== null) {
        score = f(item[field]);
        break;
      }
    }
    return new BenchmarkScore({
      modelId,
      source: "design-arena",
      taskType: null,
      benchmarkType: category,
      score,
      accuracy: null,
      stddev: null,
      raw: item,
    });
  }

  // Unknown source: keep what we can, score from any obvious numeric field.
  return new BenchmarkScore({
    modelId,
    source: src || "unknown",
    taskType: null,
    benchmarkType:
      item["benchmark_type"] !== undefined && item["benchmark_type"] !== null
        ? String(item["benchmark_type"])
        : null,
    score: f(item["score"]),
    accuracy: null,
    stddev: null,
    raw: item,
  });
}

// Re-export the error types this module surfaces, for convenience.
export { BadAuth, ProviderError, RateLimited };
