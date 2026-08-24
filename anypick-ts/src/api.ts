/**
 * High-level convenience entry: `anypick()`.
 *
 * Wires obtainers + cache, fetches models and benchmarks, joins, filters,
 * picks. See docs/api-reference.md.
 */

import { BenchmarkThreshold, ModelFilters } from "./filter.js";
import type { BenchmarkScore } from "./model.js";
import {
  type BenchmarkObtainer,
  type Cache,
  CachedBenchmarkObtainer,
  CachedModelObtainer,
  FileCache,
  type ModelListObtainer,
  NoopBenchmarkObtainer,
  type ObtainerPair,
} from "./obtainer.js";
import { OpenRouterBenchmarkObtainer, OpenRouterModelObtainer } from "./openrouter.js";
import { type Strategy, pickBest, type Selection } from "./pick.js";
import { VercelModelObtainer } from "./vercel.js";

export interface AnypickOptions {
  filters?: ModelFilters | null;
  strategy?: Strategy;
  obtainer?: string | ObtainerPair;
  openrouterApiKey?: string | null;
  vercelApiKey?: string | null;
  cache?: Cache | boolean;
  refresh?: boolean;
}

/**
 * One-shot selection.
 *
 * Wires obtainers + cache, fetches models and benchmarks, joins, filters,
 * picks. Returns a {@link Selection}. Throws {@link NoModelsFound} if the
 * filtered set is empty, `BadAuth`/`RateLimited`/`ProviderError` on provider
 * failures.
 */
export async function anypick(opts: AnypickOptions = {}): Promise<Selection> {
  const {
    filters = null,
    strategy = "cheapest",
    openrouterApiKey = null,
    vercelApiKey = null,
    cache = true,
    refresh = false,
  } = opts;
  const obtainer = opts.obtainer ?? "openrouter";

  const [modelObt, benchObt] = resolveObtainers(
    obtainer,
    openrouterApiKey,
    vercelApiKey,
    cache,
  );

  const listOpts = refresh ? { refresh: true } : {};
  const models = await modelObt.listModels(listOpts);

  let scores: BenchmarkScore[];
  if (strategyNeedsScores(strategy, filters)) {
    const benchKwargs = benchmarkKwargsFromFilters(filters);
    scores = await benchObt.listBenchmarks({
      ...benchKwargs,
      ...(refresh ? { refresh: true } : {}),
    });
  } else {
    scores = [];
  }

  return pickBest(models, scores, filters, strategy);
}

function resolveObtainers(
  obtainer: string | ObtainerPair,
  openrouterApiKey: string | null,
  vercelApiKey: string | null,
  cache: Cache | boolean,
): ObtainerPair {
  let modelObt: ModelListObtainer;
  let benchObt: BenchmarkObtainer;

  if (Array.isArray(obtainer)) {
    [modelObt, benchObt] = obtainer;
  } else if (obtainer === "openrouter") {
    const key = openrouterApiKey ?? process.env["OPENROUTER_API_KEY"] ?? null;
    modelObt = new OpenRouterModelObtainer({ apiKey: key });
    benchObt = new OpenRouterBenchmarkObtainer({ apiKey: key });
  } else if (obtainer === "vercel") {
    modelObt = new VercelModelObtainer({ apiKey: vercelApiKey });
    benchObt = new NoopBenchmarkObtainer();
  } else {
    throw new TypeError(`unknown obtainer provider: ${JSON.stringify(obtainer)}`);
  }

  if (cache === false) return [modelObt, benchObt];

  const cacheObj: Cache = isCache(cache) ? cache : new FileCache();
  return [
    new CachedModelObtainer(modelObt, cacheObj),
    new CachedBenchmarkObtainer(benchObt, cacheObj),
  ];
}

function isCache(x: unknown): x is Cache {
  return x !== null && typeof x === "object" && "get" in (x as object) && "set" in (x as object);
}

function benchmarkKwargsFromFilters(
  filters: ModelFilters | null,
): { source?: string | null; taskType?: string | null; benchmarkType?: string | null } {
  if (!(filters instanceof ModelFilters)) return {};
  const thresholds: BenchmarkThreshold[] = [];
  if (filters.minBenchmarks) thresholds.push(...filters.minBenchmarks);
  if (filters.maxBenchmarks) thresholds.push(...filters.maxBenchmarks);
  if (thresholds.length === 0) return {};
  const out: {
    source?: string | null;
    taskType?: string | null;
    benchmarkType?: string | null;
  } = {};
  for (const name of ["source", "taskType", "benchmarkType"] as const) {
    const distinct = new Set(
      thresholds.map((t) => t[name]).filter((v): v is string => v !== null),
    );
    if (distinct.size === 1) {
      out[name] = [...distinct][0]!;
    }
  }
  return out;
}

function strategyNeedsScores(strategy: Strategy, filters: ModelFilters | null): boolean {
  if (strategy !== "cheapest") return true;
  if (filters instanceof ModelFilters && (filters.minBenchmarks || filters.maxBenchmarks)) {
    return true;
  }
  return false;
}
