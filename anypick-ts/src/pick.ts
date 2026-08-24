/**
 * `pickBest` and the strategies / `Selection`.
 *
 * Pure module — no I/O. See docs/strategies.md.
 */

import { NoModelsFound } from "./errors.js";
import {
  BenchmarkThreshold,
  coerceFilter,
  survivorsByClause,
  type FilterSpec,
  ModelFilters,
} from "./filter.js";
import { type BenchmarkScore, Model, groupScoresByModel } from "./model.js";

export type Strategy = "cheapest" | "cheapest_with_floor" | "best_score" | "best_value";

/** The result of a pick. */
export class Selection {
  constructor(
    readonly model: Model,
    readonly score: BenchmarkScore | null,
    readonly promptPrice: number,
    readonly completionPrice: number,
    readonly expectedCost: number,
    readonly candidatesConsidered: number,
    readonly strategy: string,
    readonly filtersApplied: Record<string, unknown>,
  ) {}

  toJSON(): Record<string, unknown> {
    return {
      model: this.model.toJSON(),
      score: this.score ? this.score.toJSON() : null,
      promptPrice: this.promptPrice,
      completionPrice: this.completionPrice,
      expectedCost: this.expectedCost,
      candidatesConsidered: this.candidatesConsidered,
      strategy: this.strategy,
      filtersApplied: this.filtersApplied,
    };
  }
}

const VALID_STRATEGIES: ReadonlySet<Strategy> = new Set([
  "cheapest",
  "cheapest_with_floor",
  "best_score",
  "best_value",
]);

/**
 * Filter then pick the best model via `strategy`.
 *
 * @throws `NoModelsFound` if the filtered set is empty (carries per-clause counts).
 * @throws `TypeError` if a benchmark-dependent strategy is used without a
 *   `min_benchmarks` (or equivalent `pred.benchmark_*`) threshold.
 */
export function pickBest(
  models: Model[],
  scores: BenchmarkScore[],
  filters: FilterSpec = null,
  strategy: Strategy = "cheapest",
): Selection {
  if (!VALID_STRATEGIES.has(strategy)) {
    throw new TypeError(`unknown strategy: ${String(strategy)}`);
  }

  // Apply filters.
  const spec = filters instanceof ModelFilters ? filters : null;
  const fn = coerceFilter(filters);
  const grouped = groupScoresByModel(scores);
  const candidates = models.filter((m) => fn.test(m, grouped.get(m.id) ?? []));

  if (candidates.length === 0) {
    const counts: Record<string, number> =
      spec !== null ? survivorsByClause(models, scores, spec) : { filters: 0 };
    throw new NoModelsFound(counts);
  }

  const [alpha, beta] = spec ? spec.expectedCostWeights : ([1.0, 1.0] as [number, number]);
  const cost = (m: Model): number => alpha * m.promptPrice + beta * m.completionPrice;

  let best: Model;
  let chosenScore: BenchmarkScore | null;

  if (strategy === "cheapest") {
    const priced = withKnownPrice(candidates);
    if (priced.length === 0) throw new NoModelsFound({ priced: 0 });
    best = pickMin(priced, (m) => [cost(m), m.id] as Key);
    chosenScore = null;
  } else if (strategy === "cheapest_with_floor") {
    const threshold = requireThreshold(spec, strategy);
    let eligible = withScore(candidates, grouped, threshold, true);
    eligible = withKnownPrice(eligible);
    if (eligible.length === 0) throw new NoModelsFound({ "min_benchmarks[0]": 0 });
    best = pickMin(eligible, (m) => [cost(m), m.id] as Key);
    chosenScore = bestMatchingScore(best, grouped.get(best.id) ?? [], threshold);
  } else if (strategy === "best_score") {
    const threshold = requireThreshold(spec, strategy);
    const eligible = withScore(candidates, grouped, threshold, true, false);
    if (eligible.length === 0) throw new NoModelsFound({ best_score: 0 });
    // maximize score -> tie-break by lower cost, then id asc
    best = pickMax(eligible, (m) => [scoreOf(m, grouped, threshold), -cost(m), m.id] as Key);
    chosenScore = bestMatchingScore(best, grouped.get(best.id) ?? [], threshold);
  } else {
    // best_value
    const threshold = requireThreshold(spec, strategy);
    let eligible = withScore(candidates, grouped, threshold, true, false);
    eligible = withKnownPrice(eligible);
    if (eligible.length === 0) throw new NoModelsFound({ best_value: 0 });
    // minimize cost/score (higher score => better value); score>0 guaranteed
    best = pickMin(eligible, (m) => [cost(m) / scoreOf(m, grouped, threshold), m.id] as Key);
    chosenScore = bestMatchingScore(best, grouped.get(best.id) ?? [], threshold);
  }

  const filtersApplied = spec ? spec.serialize() : {};
  return new Selection(
    best,
    chosenScore,
    best.promptPrice,
    best.completionPrice,
    cost(best),
    candidates.length,
    strategy,
    filtersApplied,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the benchmark threshold a benchmark-dependent strategy ranks on.
 *
 * With a list of thresholds, the strategy ranks on the *first* one (the
 * primary quality criterion). The remaining thresholds still act as filters
 * (applied by `applyFilters`) but do not drive ranking.
 */
function requireThreshold(spec: ModelFilters | null, strategy: Strategy): BenchmarkThreshold {
  if (spec !== null) {
    if (spec.minBenchmarks && spec.minBenchmarks.length) return spec.minBenchmarks[0]!;
    if (spec.maxBenchmarks && spec.maxBenchmarks.length) return spec.maxBenchmarks[0]!;
  }
  throw new TypeError(
    `strategy ${JSON.stringify(strategy)} requires a min_benchmarks threshold (or a ` +
      "pred.benchmark_* threshold) to know which score to rank on.",
  );
}

/**
 * Keep models that have a score passing the threshold.
 *
 * When the threshold has no bound (pure scope), keep any model with a matching
 * score. Otherwise require at least one matching score to satisfy the bound.
 */
function withScore(
  models: Model[],
  grouped: Map<string, BenchmarkScore[]>,
  threshold: BenchmarkThreshold,
  wantAbove: boolean,
  requireBound: boolean = true,
): Model[] {
  const out: Model[] = [];
  for (const m of models) {
    const scores = grouped.get(m.id) ?? [];
    const candidates = scores.filter((s) => threshold.matches(s));
    if (candidates.length === 0) continue;
    if (!threshold.hasBound()) {
      out.push(m);
      continue;
    }
    if (candidates.some((s) => passes(s, threshold, wantAbove))) out.push(m);
  }
  return out;
}

function passes(s: BenchmarkScore, t: BenchmarkThreshold, wantAbove: boolean): boolean {
  if (wantAbove && t.min !== null) return s.score >= t.min;
  if (!wantAbove && t.max !== null) return s.score <= t.max;
  return false;
}

/** The best matching score for `m` (max), or 0.0 if none. */
function scoreOf(
  m: Model,
  grouped: Map<string, BenchmarkScore[]>,
  threshold: BenchmarkThreshold,
): number {
  const scores = grouped.get(m.id) ?? [];
  const candidates = scores.filter((s) => threshold.matches(s));
  if (candidates.length === 0) return 0.0;
  return Math.max(...candidates.map((s) => s.score));
}

function bestMatchingScore(
  m: Model,
  scores: BenchmarkScore[],
  threshold: BenchmarkThreshold,
): BenchmarkScore | null {
  const candidates = scores.filter((s) => threshold.matches(s));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, s) => (s.score > best.score ? s : best));
}

/**
 * Drop models whose prompt/completion price is negative (sentinel 'N/A').
 *
 * OpenRouter reports `-1` for meta-router models like `openrouter/auto` whose
 * pricing varies per request. Such models can't be ranked by cost.
 */
function withKnownPrice(models: Model[]): Model[] {
  return models.filter((m) => m.promptPrice >= 0 && m.completionPrice >= 0);
}

/** A lexicographic key element (number or string, mirroring Python tuples). */
type Key = (number | string)[];

/** The item with the minimum lexicographic key; ties go to the first seen. */
function pickMin<T>(items: T[], key: (item: T) => Key): T {
  let best = items[0]!;
  let bestKey = key(best);
  for (let i = 1; i < items.length; i++) {
    const item = items[i]!;
    const k = key(item);
    if (cmpKey(k, bestKey) < 0) {
      best = item;
      bestKey = k;
    }
  }
  return best;
}

/** The item with the maximum lexicographic key; ties go to the first seen. */
function pickMax<T>(items: T[], key: (item: T) => Key): T {
  let best = items[0]!;
  let bestKey = key(best);
  for (let i = 1; i < items.length; i++) {
    const item = items[i]!;
    const k = key(item);
    if (cmpKey(k, bestKey) > 0) {
      best = item;
      bestKey = k;
    }
  }
  return best;
}

function cmpKey(a: Key, b: Key): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmpKeyElem(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  if (a.length < b.length) return -1;
  if (a.length > b.length) return 1;
  return 0;
}

function cmpKeyElem(x: number | string, y: number | string): number {
  if (typeof x === "number" && typeof y === "number") {
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const xs = String(x);
  const ys = String(y);
  return xs < ys ? -1 : xs > ys ? 1 : 0;
}
