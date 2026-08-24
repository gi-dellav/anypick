/**
 * Filter DSL: spec form (`ModelFilters`) and predicate combinators (`pred`).
 *
 * Both forms compile to the same `Predicate` callable and are applied by
 * `applyFilters`. See docs/filters.md.
 */

import { type BenchmarkScore, Model, groupScoresByModel } from "./model.js";

/** A predicate over (model, that model's scores). */
export type PredicateFn = (model: Model, scores: BenchmarkScore[]) => boolean;

/**
 * A composable predicate supporting `.and()`, `.or()`, `.not()`.
 *
 * JavaScript does not overload `&`/`|`/`~`, so the predicate form uses method
 * combinators instead of Python's operators.
 */
export class Predicate {
  constructor(readonly fn: PredicateFn) {}

  test(model: Model, scores: BenchmarkScore[]): boolean {
    return this.fn(model, scores);
  }

  and(other: Predicate | PredicateFn): Predicate {
    const o = other instanceof Predicate ? other : new Predicate(other);
    return new Predicate((m, s) => this.fn(m, s) && o.fn(m, s));
  }

  or(other: Predicate | PredicateFn): Predicate {
    const o = other instanceof Predicate ? other : new Predicate(other);
    return new Predicate((m, s) => this.fn(m, s) || o.fn(m, s));
  }

  not(): Predicate {
    return new Predicate((m, s) => !this.fn(m, s));
  }
}

// ---------------------------------------------------------------------------
// Benchmark threshold
// ---------------------------------------------------------------------------

export interface BenchmarkThresholdOptions {
  source?: string | null;
  taskType?: string | null;
  benchmarkType?: string | null;
  min?: number | null;
  max?: number | null;
}

/** A benchmark constraint, optionally scoped by source/task/benchmark. */
export class BenchmarkThreshold {
  readonly source: string | null;
  readonly taskType: string | null;
  readonly benchmarkType: string | null;
  readonly min: number | null;
  readonly max: number | null;

  constructor(opts: BenchmarkThresholdOptions = {}) {
    this.source = opts.source ?? null;
    this.taskType = opts.taskType ?? null;
    this.benchmarkType = opts.benchmarkType ?? null;
    this.min = opts.min ?? null;
    this.max = opts.max ?? null;
  }

  /** Does this score fall under the threshold's scope? */
  matches(s: BenchmarkScore): boolean {
    if (this.source !== null && s.source !== this.source) return false;
    if (this.taskType !== null && s.taskType !== this.taskType) return false;
    if (this.benchmarkType !== null && s.benchmarkType !== this.benchmarkType) return false;
    return true;
  }

  /** Whether the threshold has a numeric bound (min or max). */
  hasBound(): boolean {
    return this.min !== null || this.max !== null;
  }
}

// ---------------------------------------------------------------------------
// Spec form
// ---------------------------------------------------------------------------

export interface ModelFiltersOptions {
  // ids / makers
  includeIds?: string[];
  excludeIds?: string[];
  includeMakers?: string[];
  excludeMakers?: string[];
  // price (USD/token)
  minPromptPrice?: number;
  maxPromptPrice?: number;
  minCompletionPrice?: number;
  maxCompletionPrice?: number;
  minExpectedCost?: number;
  maxExpectedCost?: number;
  expectedCostWeights?: [number, number];
  maxCacheReadPrice?: number;
  // context
  minContextLength?: number;
  maxContextLength?: number;
  // modalities (input)
  modalitiesIn?: string[];
  modalitiesExactly?: string[];
  excludesModalities?: string[];
  // modalities (output)
  outputModalitiesIn?: string[];
  outputModalitiesExactly?: string[];
  excludesOutputModalities?: string[];
  // capabilities (tri-state: null/undefined=ignore, true=require, false=forbid)
  requiresTools?: boolean | null;
  requiresReasoning?: boolean | null;
  requiresStructuredOutputs?: boolean | null;
  // benchmarks
  minBenchmarks?: BenchmarkThreshold[];
  maxBenchmarks?: BenchmarkThreshold[];
}

/**
 * The ergonomic filter spec. Every field is optional (`undefined`/`null` =
 * no constraint).
 *
 * Capability flags (`requiresTools` etc.) are *tri-state*: `null`/`undefined`
 * ignores the dimension, `true` requires it, `false` forbids it.
 * `minBenchmarks` / `maxBenchmarks` are lists; a model must satisfy *every*
 * threshold (logical AND). See docs/filters.md.
 */
export class ModelFilters {
  includeIds?: string[];
  excludeIds?: string[];
  includeMakers?: string[];
  excludeMakers?: string[];

  minPromptPrice?: number;
  maxPromptPrice?: number;
  minCompletionPrice?: number;
  maxCompletionPrice?: number;
  minExpectedCost?: number;
  maxExpectedCost?: number;
  expectedCostWeights: [number, number];
  maxCacheReadPrice?: number;

  minContextLength?: number;
  maxContextLength?: number;

  modalitiesIn?: string[];
  modalitiesExactly?: string[];
  excludesModalities?: string[];
  outputModalitiesIn?: string[];
  outputModalitiesExactly?: string[];
  excludesOutputModalities?: string[];

  requiresTools?: boolean | null;
  requiresReasoning?: boolean | null;
  requiresStructuredOutputs?: boolean | null;

  minBenchmarks?: BenchmarkThreshold[];
  maxBenchmarks?: BenchmarkThreshold[];

  constructor(opts: ModelFiltersOptions = {}) {
    this.includeIds = opts.includeIds;
    this.excludeIds = opts.excludeIds;
    this.includeMakers = opts.includeMakers;
    this.excludeMakers = opts.excludeMakers;

    this.minPromptPrice = opts.minPromptPrice;
    this.maxPromptPrice = opts.maxPromptPrice;
    this.minCompletionPrice = opts.minCompletionPrice;
    this.maxCompletionPrice = opts.maxCompletionPrice;
    this.minExpectedCost = opts.minExpectedCost;
    this.maxExpectedCost = opts.maxExpectedCost;
    this.expectedCostWeights = opts.expectedCostWeights ?? [1.0, 1.0];
    this.maxCacheReadPrice = opts.maxCacheReadPrice;

    this.minContextLength = opts.minContextLength;
    this.maxContextLength = opts.maxContextLength;

    this.modalitiesIn = opts.modalitiesIn;
    this.modalitiesExactly = opts.modalitiesExactly;
    this.excludesModalities = opts.excludesModalities;
    this.outputModalitiesIn = opts.outputModalitiesIn;
    this.outputModalitiesExactly = opts.outputModalitiesExactly;
    this.excludesOutputModalities = opts.excludesOutputModalities;

    this.requiresTools = opts.requiresTools;
    this.requiresReasoning = opts.requiresReasoning;
    this.requiresStructuredOutputs = opts.requiresStructuredOutputs;

    this.minBenchmarks = opts.minBenchmarks;
    this.maxBenchmarks = opts.maxBenchmarks;
  }

  /** Compile this spec to a single `Predicate`. */
  toPredicate(): Predicate {
    const clauses = specClauses(this);
    return all(clauses.map(([, c]) => c));
  }

  /** Serializable form (snake_case keys, matching the Python reference). */
  serialize(): Record<string, unknown> {
    const d: Record<string, unknown> = {};
    if (this.includeIds !== undefined) d.include_ids = this.includeIds;
    if (this.excludeIds !== undefined) d.exclude_ids = this.excludeIds;
    if (this.includeMakers !== undefined) d.include_makers = this.includeMakers;
    if (this.excludeMakers !== undefined) d.exclude_makers = this.excludeMakers;
    if (this.minPromptPrice !== undefined) d.min_prompt_price = this.minPromptPrice;
    if (this.maxPromptPrice !== undefined) d.max_prompt_price = this.maxPromptPrice;
    if (this.minCompletionPrice !== undefined) d.min_completion_price = this.minCompletionPrice;
    if (this.maxCompletionPrice !== undefined) d.max_completion_price = this.maxCompletionPrice;
    if (this.minExpectedCost !== undefined) d.min_expected_cost = this.minExpectedCost;
    if (this.maxExpectedCost !== undefined) d.max_expected_cost = this.maxExpectedCost;
    d.expected_cost_weights = [...this.expectedCostWeights];
    if (this.maxCacheReadPrice !== undefined) d.max_cache_read_price = this.maxCacheReadPrice;
    if (this.minContextLength !== undefined) d.min_context_length = this.minContextLength;
    if (this.maxContextLength !== undefined) d.max_context_length = this.maxContextLength;
    if (this.modalitiesIn !== undefined) d.modalities_in = this.modalitiesIn;
    if (this.modalitiesExactly !== undefined) d.modalities_exactly = this.modalitiesExactly;
    if (this.excludesModalities !== undefined) d.excludes_modalities = this.excludesModalities;
    if (this.outputModalitiesIn !== undefined) d.output_modalities_in = this.outputModalitiesIn;
    if (this.outputModalitiesExactly !== undefined)
      d.output_modalities_exactly = this.outputModalitiesExactly;
    if (this.excludesOutputModalities !== undefined)
      d.excludes_output_modalities = this.excludesOutputModalities;
    if (this.requiresTools !== undefined && this.requiresTools !== null)
      d.requires_tools = this.requiresTools;
    if (this.requiresReasoning !== undefined && this.requiresReasoning !== null)
      d.requires_reasoning = this.requiresReasoning;
    if (this.requiresStructuredOutputs !== undefined && this.requiresStructuredOutputs !== null)
      d.requires_structured_outputs = this.requiresStructuredOutputs;
    if (this.minBenchmarks !== undefined)
      d.min_benchmarks = this.minBenchmarks.map((b) => serializeThreshold(b));
    if (this.maxBenchmarks !== undefined)
      d.max_benchmarks = this.maxBenchmarks.map((b) => serializeThreshold(b));
    return d;
  }
}

function serializeThreshold(t: BenchmarkThreshold): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (t.source !== null) o.source = t.source;
  if (t.taskType !== null) o.task_type = t.taskType;
  if (t.benchmarkType !== null) o.benchmark_type = t.benchmarkType;
  if (t.min !== null) o.min = t.min;
  if (t.max !== null) o.max = t.max;
  return o;
}

// ---------------------------------------------------------------------------
// Maker helper
// ---------------------------------------------------------------------------

/**
 * The maker prefix before the first `/` in `modelId`, or null.
 *
 * Ids without a `/` have no maker. Any leading sigil is preserved verbatim
 * (e.g. `"~deepseek/..."` -> `"~deepseek"`).
 */
export function makerOf(modelId: string): string | null {
  const idx = modelId.indexOf("/");
  if (idx < 0) return null;
  return modelId.slice(0, idx);
}

// ---------------------------------------------------------------------------
// Predicate combinators
// ---------------------------------------------------------------------------

function all(clauses: Predicate[]): Predicate {
  if (clauses.length === 0) return new Predicate(() => true);
  const compiled = clauses.map((c) => (c instanceof Predicate ? c : new Predicate(c)));
  return new Predicate((m, s) => compiled.every((c) => c.fn(m, s)));
}

/**
 * Build a predicate that checks a model has a matching score above/below bound.
 *
 * *Unknown != zero*: a model with no matching score is kept iff the threshold
 * specifies no bound (a pure scoping filter). When a bound is present,
 * scoreless models are dropped.
 */
export function benchmarkPredicate(threshold: BenchmarkThreshold, wantAbove: boolean): Predicate {
  return new Predicate((_m, scores) => {
    const candidates = scores.filter((s) => threshold.matches(s));
    if (!threshold.hasBound()) {
      // Pure scope: keep models that have at least one matching score.
      return candidates.length > 0;
    }
    for (const s of candidates) {
      if (wantAbove && threshold.min !== null && s.score >= threshold.min) return true;
      if (!wantAbove && threshold.max !== null && s.score <= threshold.max) return true;
    }
    return false;
  });
}

/** Factory namespace for predicate combinators. */
export const pred = {
  // --- ids / makers ---
  idIn(ids: string[]): Predicate {
    const good = new Set(ids);
    return new Predicate((m) => good.has(m.id));
  },
  idNotIn(ids: string[]): Predicate {
    const bad = new Set(ids);
    return new Predicate((m) => !bad.has(m.id));
  },
  makerIn(makers: string[]): Predicate {
    const ms = new Set(makers);
    return new Predicate((m) => makerOf(m.id) !== null && ms.has(makerOf(m.id)!));
  },
  makerNotIn(makers: string[]): Predicate {
    const ms = new Set(makers);
    return new Predicate((m) => {
      const mk = makerOf(m.id);
      return mk === null || !ms.has(mk);
    });
  },

  // --- price ---
  priceBelow(opts: { prompt?: number; completion?: number }): Predicate {
    const clauses: PredicateFn[] = [];
    if (opts.prompt !== undefined)
      clauses.push((m) => m.promptPrice <= opts.prompt!);
    if (opts.completion !== undefined)
      clauses.push((m) => m.completionPrice <= opts.completion!);
    return all(clauses.map((c) => new Predicate(c)));
  },
  priceAbove(opts: { prompt?: number; completion?: number }): Predicate {
    const clauses: PredicateFn[] = [];
    if (opts.prompt !== undefined)
      clauses.push((m) => m.promptPrice >= opts.prompt!);
    if (opts.completion !== undefined)
      clauses.push((m) => m.completionPrice >= opts.completion!);
    return all(clauses.map((c) => new Predicate(c)));
  },
  expectedCostBelow(max: number, weights: [number, number] = [1.0, 1.0]): Predicate {
    const [a, b] = weights;
    return new Predicate((m) => a * m.promptPrice + b * m.completionPrice <= max);
  },
  expectedCostAbove(min: number, weights: [number, number] = [1.0, 1.0]): Predicate {
    const [a, b] = weights;
    return new Predicate((m) => a * m.promptPrice + b * m.completionPrice >= min);
  },
  cacheReadPriceBelow(max: number): Predicate {
    return new Predicate((m) => m.cacheReadPrice <= max);
  },

  // --- context ---
  contextAtLeast(n: number): Predicate {
    return new Predicate((m) => m.contextLength >= n);
  },
  contextAtMost(n: number): Predicate {
    return new Predicate((m) => m.contextLength <= n);
  },

  // --- modalities (input) ---
  modalitiesIn(want: string[]): Predicate {
    const w = new Set(want);
    return new Predicate((m) => isSuperset(m.inputModalities, w));
  },
  modalitiesExactly(want: string[]): Predicate {
    const w = new Set(want);
    return new Predicate((m) => setsEqual(m.inputModalities, w));
  },
  modalitiesNotIn(want: string[]): Predicate {
    const w = new Set(want);
    return new Predicate((m) => isDisjoint(m.inputModalities, w));
  },
  // --- modalities (output) ---
  outputModalitiesIn(want: string[]): Predicate {
    const w = new Set(want);
    return new Predicate((m) => isSuperset(m.outputModalities, w));
  },
  outputModalitiesExactly(want: string[]): Predicate {
    const w = new Set(want);
    return new Predicate((m) => setsEqual(m.outputModalities, w));
  },
  outputModalitiesNotIn(want: string[]): Predicate {
    const w = new Set(want);
    return new Predicate((m) => isDisjoint(m.outputModalities, w));
  },

  // --- capabilities ---
  supportsTools(): Predicate {
    return new Predicate((m) => m.supportsTools);
  },
  supportsReasoning(): Predicate {
    return new Predicate((m) => m.supportsReasoning);
  },
  supportsStructuredOutputs(): Predicate {
    return new Predicate((m) => m.supportsStructuredOutputs);
  },

  // --- benchmarks ---
  benchmarkAbove(opts: {
    source?: string | null;
    taskType?: string | null;
    benchmarkType?: string | null;
    min?: number;
  }): Predicate {
    const bt = new BenchmarkThreshold({
      source: opts.source ?? null,
      taskType: opts.taskType ?? null,
      benchmarkType: opts.benchmarkType ?? null,
      min: opts.min ?? null,
    });
    return benchmarkPredicate(bt, true);
  },
  benchmarkBelow(opts: {
    source?: string | null;
    taskType?: string | null;
    benchmarkType?: string | null;
    max?: number;
  }): Predicate {
    const bt = new BenchmarkThreshold({
      source: opts.source ?? null,
      taskType: opts.taskType ?? null,
      benchmarkType: opts.benchmarkType ?? null,
      max: opts.max ?? null,
    });
    return benchmarkPredicate(bt, false);
  },
};

function isSuperset(have: string[], want: Set<string>): boolean {
  for (const w of want) {
    if (!have.includes(w)) return false;
  }
  return true;
}
function setsEqual(have: string[], want: Set<string>): boolean {
  if (have.length !== want.size) return false;
  for (const h of have) if (!want.has(h)) return false;
  return true;
}
function isDisjoint(have: string[], want: Set<string>): boolean {
  for (const h of have) if (want.has(h)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Spec -> clauses (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Enumerate (clause-name, predicate) pairs in application order.
 *
 * Single source of truth for `ModelFilters.toPredicate()` and
 * `survivorsByClause` (the per-clause diagnostic used by `NoModelsFound`).
 */
export function specClauses(filters: ModelFilters): Array<[string, Predicate]> {
  const out: Array<[string, Predicate]> = [];
  const f = filters;

  // ids / makers
  if (f.includeIds !== undefined) {
    const good = new Set(f.includeIds);
    out.push(["include_ids", new Predicate((m) => good.has(m.id))]);
  }
  if (f.excludeIds !== undefined) {
    const bad = new Set(f.excludeIds);
    out.push(["exclude_ids", new Predicate((m) => !bad.has(m.id))]);
  }
  if (f.includeMakers !== undefined) {
    const ms = new Set(f.includeMakers);
    out.push(["include_makers", new Predicate((m) => makerOf(m.id) !== null && ms.has(makerOf(m.id)!))]);
  }
  if (f.excludeMakers !== undefined) {
    const ms = new Set(f.excludeMakers);
    out.push([
      "exclude_makers",
      new Predicate((m) => {
        const mk = makerOf(m.id);
        return mk === null || !ms.has(mk);
      }),
    ]);
  }

  // price
  if (f.minPromptPrice !== undefined) {
    const v = f.minPromptPrice;
    out.push(["min_prompt_price", new Predicate((m) => m.promptPrice >= v)]);
  }
  if (f.maxPromptPrice !== undefined) {
    const v = f.maxPromptPrice;
    out.push(["max_prompt_price", new Predicate((m) => m.promptPrice <= v)]);
  }
  if (f.minCompletionPrice !== undefined) {
    const v = f.minCompletionPrice;
    out.push(["min_completion_price", new Predicate((m) => m.completionPrice >= v)]);
  }
  if (f.maxCompletionPrice !== undefined) {
    const v = f.maxCompletionPrice;
    out.push(["max_completion_price", new Predicate((m) => m.completionPrice <= v)]);
  }
  if (f.minExpectedCost !== undefined) {
    const [a, b] = f.expectedCostWeights;
    const v = f.minExpectedCost;
    out.push([
      "min_expected_cost",
      new Predicate((m) => a * m.promptPrice + b * m.completionPrice >= v),
    ]);
  }
  if (f.maxExpectedCost !== undefined) {
    const [a, b] = f.expectedCostWeights;
    const v = f.maxExpectedCost;
    out.push([
      "max_expected_cost",
      new Predicate((m) => a * m.promptPrice + b * m.completionPrice <= v),
    ]);
  }
  if (f.maxCacheReadPrice !== undefined) {
    const v = f.maxCacheReadPrice;
    out.push(["max_cache_read_price", new Predicate((m) => m.cacheReadPrice <= v)]);
  }

  // context
  if (f.minContextLength !== undefined) {
    const n = f.minContextLength;
    out.push(["min_context_length", new Predicate((m) => m.contextLength >= n)]);
  }
  if (f.maxContextLength !== undefined) {
    const n = f.maxContextLength;
    out.push(["max_context_length", new Predicate((m) => m.contextLength <= n)]);
  }

  // modalities (input)
  if (f.modalitiesIn !== undefined) {
    const w = new Set(f.modalitiesIn);
    out.push(["modalities_in", new Predicate((m) => isSuperset(m.inputModalities, w))]);
  }
  if (f.modalitiesExactly !== undefined) {
    const w = new Set(f.modalitiesExactly);
    out.push(["modalities_exactly", new Predicate((m) => setsEqual(m.inputModalities, w))]);
  }
  if (f.excludesModalities !== undefined) {
    const w = new Set(f.excludesModalities);
    out.push(["excludes_modalities", new Predicate((m) => isDisjoint(m.inputModalities, w))]);
  }
  // modalities (output)
  if (f.outputModalitiesIn !== undefined) {
    const w = new Set(f.outputModalitiesIn);
    out.push(["output_modalities_in", new Predicate((m) => isSuperset(m.outputModalities, w))]);
  }
  if (f.outputModalitiesExactly !== undefined) {
    const w = new Set(f.outputModalitiesExactly);
    out.push(["output_modalities_exactly", new Predicate((m) => setsEqual(m.outputModalities, w))]);
  }
  if (f.excludesOutputModalities !== undefined) {
    const w = new Set(f.excludesOutputModalities);
    out.push(["excludes_output_modalities", new Predicate((m) => isDisjoint(m.outputModalities, w))]);
  }

  // capabilities (tri-state)
  if (f.requiresTools !== undefined && f.requiresTools !== null) {
    const want = f.requiresTools;
    out.push(["requires_tools", new Predicate((m) => m.supportsTools === want)]);
  }
  if (f.requiresReasoning !== undefined && f.requiresReasoning !== null) {
    const want = f.requiresReasoning;
    out.push(["requires_reasoning", new Predicate((m) => m.supportsReasoning === want)]);
  }
  if (f.requiresStructuredOutputs !== undefined && f.requiresStructuredOutputs !== null) {
    const want = f.requiresStructuredOutputs;
    out.push([
      "requires_structured_outputs",
      new Predicate((m) => m.supportsStructuredOutputs === want),
    ]);
  }

  // benchmarks (each threshold is its own diagnostic clause)
  if (f.minBenchmarks && f.minBenchmarks.length) {
    f.minBenchmarks.forEach((bt, i) => {
      out.push([`min_benchmarks[${i}]`, benchmarkPredicate(bt, true)]);
    });
  }
  if (f.maxBenchmarks && f.maxBenchmarks.length) {
    f.maxBenchmarks.forEach((bt, i) => {
      out.push([`max_benchmarks[${i}]`, benchmarkPredicate(bt, false)]);
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

/** A filter spec: a `ModelFilters`, a `Predicate`, or null (keep all). */
export type FilterSpec = ModelFilters | Predicate | null;

export function coerceFilter(filters: FilterSpec): Predicate {
  if (filters === null || filters === undefined) return new Predicate(() => true);
  if (filters instanceof ModelFilters) return filters.toPredicate();
  return filters instanceof Predicate ? filters : new Predicate(filters);
}

/** Apply a filter spec to `(models, scores)` and return the survivors. */
export function applyFilters(
  models: Model[],
  scores: BenchmarkScore[],
  filters: FilterSpec = null,
): Model[] {
  const fn = coerceFilter(filters);
  const grouped = groupScoresByModel(scores);
  return models.filter((m) => fn.test(m, grouped.get(m.id) ?? []));
}

/** Compute per-clause surviving counts (cumulative, in application order). */
export function survivorsByClause(
  models: Model[],
  scores: BenchmarkScore[],
  filters: ModelFilters,
): Record<string, number> {
  const grouped = groupScoresByModel(scores);
  let current = models;
  const out: Record<string, number> = {};
  for (const [name, clause] of specClauses(filters)) {
    current = current.filter((m) => clause.test(m, grouped.get(m.id) ?? []));
    out[name] = current.length;
  }
  return out;
}
