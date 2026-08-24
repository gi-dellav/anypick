/**
 * Normalized, provider-agnostic types.
 *
 * These two structs are the *currency* of anypick: every obtainer translates
 * its raw payload into them, and the filter/pick layers operate on them and
 * nothing else. See docs/architecture.md.
 */

export interface ModelData {
  id: string;
  name: string;
  contextLength: number;
  inputModalities: string[];
  outputModalities: string[];
  promptPrice: number;
  completionPrice: number;
  cacheReadPrice: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsStructuredOutputs: boolean;
  raw: Record<string, unknown>;
}

export interface ModelOptions extends Partial<Omit<ModelData, "id" | "name" | "contextLength">> {
  id: string;
  name: string;
  contextLength: number;
}

/**
 * A normalized model record.
 *
 * `id` is the canonical model id (e.g. `"openai/gpt-4o"`) and the join key for
 * benchmark scores. Prices are USD per token. `raw` keeps the original
 * provider payload for power users.
 */
export class Model implements ModelData {
  readonly id: string;
  readonly name: string;
  readonly contextLength: number;
  readonly inputModalities: string[];
  readonly outputModalities: string[];
  readonly promptPrice: number;
  readonly completionPrice: number;
  readonly cacheReadPrice: number;
  readonly supportsTools: boolean;
  readonly supportsReasoning: boolean;
  readonly supportsStructuredOutputs: boolean;
  readonly raw: Record<string, unknown>;

  constructor(opts: ModelOptions) {
    this.id = opts.id;
    this.name = opts.name;
    this.contextLength = opts.contextLength;
    this.inputModalities = opts.inputModalities ?? [];
    this.outputModalities = opts.outputModalities ?? [];
    this.promptPrice = opts.promptPrice ?? 0;
    this.completionPrice = opts.completionPrice ?? 0;
    this.cacheReadPrice = opts.cacheReadPrice ?? 0;
    this.supportsTools = opts.supportsTools ?? false;
    this.supportsReasoning = opts.supportsReasoning ?? false;
    this.supportsStructuredOutputs = opts.supportsStructuredOutputs ?? false;
    this.raw = opts.raw ?? {};
  }

  /** `promptPrice + completionPrice` (equal-weight expected cost). */
  get expectedCost(): number {
    return this.promptPrice + this.completionPrice;
  }

  toJSON(): ModelData {
    return {
      id: this.id,
      name: this.name,
      contextLength: this.contextLength,
      inputModalities: this.inputModalities,
      outputModalities: this.outputModalities,
      promptPrice: this.promptPrice,
      completionPrice: this.completionPrice,
      cacheReadPrice: this.cacheReadPrice,
      supportsTools: this.supportsTools,
      supportsReasoning: this.supportsReasoning,
      supportsStructuredOutputs: this.supportsStructuredOutputs,
      raw: this.raw,
    };
  }

  static fromJSON(d: ModelData): Model {
    return new Model(d);
  }
}

export interface BenchmarkScoreData {
  modelId: string;
  source: string;
  score: number;
  taskType: string | null;
  benchmarkType: string | null;
  accuracy: number | null;
  stddev: number | null;
  raw: Record<string, unknown>;
}

export interface BenchmarkScoreOptions extends Partial<Omit<BenchmarkScoreData, "modelId" | "source" | "score">> {
  modelId: string;
  source: string;
  score: number;
}

/**
 * A single benchmark measurement for a model.
 *
 * A model may carry several of these (different sources / task types /
 * benchmark types). `score` is on the *source's native scale* — see
 * docs/architecture.md §"Why score is not re-normalized".
 */
export class BenchmarkScore implements BenchmarkScoreData {
  readonly modelId: string;
  readonly source: string;
  readonly score: number;
  readonly taskType: string | null;
  readonly benchmarkType: string | null;
  readonly accuracy: number | null;
  readonly stddev: number | null;
  readonly raw: Record<string, unknown>;

  constructor(opts: BenchmarkScoreOptions) {
    this.modelId = opts.modelId;
    this.source = opts.source;
    this.score = opts.score;
    this.taskType = opts.taskType ?? null;
    this.benchmarkType = opts.benchmarkType ?? null;
    this.accuracy = opts.accuracy ?? null;
    this.stddev = opts.stddev ?? null;
    this.raw = opts.raw ?? {};
  }

  toJSON(): BenchmarkScoreData {
    return {
      modelId: this.modelId,
      source: this.source,
      score: this.score,
      taskType: this.taskType,
      benchmarkType: this.benchmarkType,
      accuracy: this.accuracy,
      stddev: this.stddev,
      raw: this.raw,
    };
  }

  static fromJSON(d: BenchmarkScoreData): BenchmarkScore {
    return new BenchmarkScore(d);
  }
}

/** Group benchmark scores by `modelId`. */
export function groupScoresByModel(scores: BenchmarkScore[]): Map<string, BenchmarkScore[]> {
  const out = new Map<string, BenchmarkScore[]>();
  for (const s of scores) {
    let list = out.get(s.modelId);
    if (!list) {
      list = [];
      out.set(s.modelId, list);
    }
    list.push(s);
  }
  return out;
}
