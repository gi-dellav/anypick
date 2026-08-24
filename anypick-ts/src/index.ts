/**
 * anypick — select an LLM across providers using capability, pricing and
 * benchmark filters, then pick the best.
 *
 * Public API:
 * - `anypick()` — one-shot selection
 * - `pickBest()` — strategy decision over pre-fetched data
 * - `ModelFilters`, `BenchmarkThreshold` — spec filters
 * - `pred` — predicate combinators (`pred.priceBelow(...).and(...)`)
 * - `Model`, `BenchmarkScore` — normalized types
 * - `ModelListObtainer`, `BenchmarkObtainer` — extension interfaces
 * - `OpenRouterModelObtainer`, `OpenRouterBenchmarkObtainer` — first provider
 * - `VercelModelObtainer` — models-only provider (AI Gateway)
 * - `CachedModelObtainer`, `CachedBenchmarkObtainer`, `Cache`, `FileCache`, `MemoryCache`
 * - `Selection`, `Strategy`
 * - `NoModelsFound`, `BadAuth`, `RateLimited`, `ProviderError`
 */

export { anypick, type AnypickOptions } from "./api.js";
export {
  BenchmarkThreshold,
  type BenchmarkThresholdOptions,
  ModelFilters,
  type ModelFiltersOptions,
  Predicate,
  type PredicateFn,
  applyFilters,
  benchmarkPredicate,
  coerceFilter,
  makerOf,
  pred,
  specClauses,
  survivorsByClause,
  type FilterSpec,
} from "./filter.js";
export {
  AnypickError,
  BadAuth,
  NoModelsFound,
  ProviderError,
  RateLimited,
} from "./errors.js";
export {
  BenchmarkScore,
  type BenchmarkScoreData,
  type BenchmarkScoreOptions,
  Model,
  type ModelData,
  type ModelOptions,
  groupScoresByModel,
} from "./model.js";
export {
  type BenchmarkObtainer,
  CachedBenchmarkObtainer,
  CachedModelObtainer,
  type Cache,
  FileCache,
  type ListBenchmarksOptions,
  type ListModelsOptions,
  type ModelListObtainer,
  MemoryCache,
  NoopBenchmarkObtainer,
  type ObtainerPair,
  hashKey,
} from "./obtainer.js";
export {
  DEFAULT_BASE_URL as OPENROUTER_DEFAULT_BASE_URL,
  OpenRouterBenchmarkObtainer,
  OpenRouterModelObtainer,
  mapBenchmark,
  mapModel,
} from "./openrouter.js";
export {
  type Selection,
  type Strategy,
  pickBest,
} from "./pick.js";
export {
  DEFAULT_BASE_URL as VERCEL_DEFAULT_BASE_URL,
  VercelModelObtainer,
  mapModel as mapVercelModel,
} from "./vercel.js";

export const VERSION = "0.1.0";
