/** Tests for pickBest and strategies. Uses a controlled model set. */
import { describe, it, expect } from "vitest";
import {
  BenchmarkThreshold,
  Model,
  ModelFilters,
  NoModelsFound,
  pickBest,
  pred,
} from "../src/index.js";
import { scoresFromFixture } from "./conftest.js";

/** A controlled catalog: the three models the benchmark fixture scores. */
function catalog(): Model[] {
  return [
    new Model({
      id: "openai/gpt-4o",
      name: "GPT-4o",
      contextLength: 128000,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      promptPrice: 2.5e-6,
      completionPrice: 1.0e-5,
      supportsTools: true,
      supportsStructuredOutputs: true,
    }),
    new Model({
      id: "meta-llama/llama-3.3-70b-instruct",
      name: "Llama 3.3 70B",
      contextLength: 131072,
      inputModalities: ["text"],
      outputModalities: ["text"],
      promptPrice: 1.0e-7,
      completionPrice: 3.2e-7,
      supportsTools: true,
    }),
    new Model({
      id: "qwen/qwen3.8-27b",
      name: "Qwen3.8 27B",
      contextLength: 262144,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      promptPrice: 4.5e-7,
      completionPrice: 3.2e-6,
      supportsTools: true,
    }),
  ];
}

describe("pickBest: cheapest", () => {
  it("picks the lowest price", () => {
    const f = new ModelFilters({ requiresTools: true, minContextLength: 128_000 });
    const sel = pickBest(catalog(), scoresFromFixture("coding"), f, "cheapest");
    expect(sel.model.id).toBe("meta-llama/llama-3.3-70b-instruct");
    expect(sel.score).toBeNull();
    expect(sel.expectedCost).toBe(sel.model.promptPrice + sel.model.completionPrice);
    expect(sel.candidatesConsidered).toBe(3);
  });
});

describe("pickBest: cheapest_with_floor", () => {
  it("picks cheapest among floor-passing", () => {
    const f = new ModelFilters({
      requiresTools: true,
      minContextLength: 128_000,
      minBenchmarks: [new BenchmarkThreshold({ taskType: "coding", min: 60 })],
    });
    const sel = pickBest(catalog(), scoresFromFixture("coding"), f, "cheapest_with_floor");
    expect(sel.model.id).toBe("meta-llama/llama-3.3-70b-instruct");
    expect(sel.score).not.toBeNull();
    expect(sel.score!.score).toBe(60.0);
    expect(sel.score!.taskType).toBe("coding");
  });

  it("excludes below-threshold models", () => {
    const f = new ModelFilters({
      requiresTools: true,
      minContextLength: 128_000,
      minBenchmarks: [new BenchmarkThreshold({ taskType: "coding", min: 61 })],
    });
    const sel = pickBest(catalog(), scoresFromFixture("coding"), f, "cheapest_with_floor");
    expect(sel.model.id).toBe("qwen/qwen3.8-27b");
    expect(sel.score!.score).toBe(80.5);
  });
});

describe("pickBest: best_score", () => {
  it("picks the highest score", () => {
    const f = new ModelFilters({
      requiresTools: true,
      minContextLength: 128_000,
      minBenchmarks: [new BenchmarkThreshold({ taskType: "coding" })],
    });
    const sel = pickBest(catalog(), scoresFromFixture("coding"), f, "best_score");
    expect(sel.model.id).toBe("qwen/qwen3.8-27b");
    expect(sel.score!.score).toBe(80.5);
  });

  it("uses source scoping", () => {
    const f = new ModelFilters({
      requiresTools: true,
      minContextLength: 128_000,
      minBenchmarks: [
        new BenchmarkThreshold({ source: "openrouter", benchmarkType: "gpqa_diamond" }),
      ],
    });
    const sel = pickBest(catalog(), scoresFromFixture(), f, "best_score");
    expect(sel.model.id).toBe("openai/gpt-4o");
    expect(sel.score!.score).toBe(0.72);
    expect(sel.score!.source).toBe("openrouter");
  });
});

describe("pickBest: best_value", () => {
  it("minimizes cost/score", () => {
    const f = new ModelFilters({
      requiresTools: true,
      minContextLength: 128_000,
      minBenchmarks: [new BenchmarkThreshold({ taskType: "coding" })],
    });
    const sel = pickBest(catalog(), scoresFromFixture("coding"), f, "best_value");
    expect(sel.model.id).toBe("meta-llama/llama-3.3-70b-instruct");
  });
});

describe("pickBest: edge cases", () => {
  it("raises NoModelsFound with per-clause counts", () => {
    const f = new ModelFilters({ minContextLength: 10 ** 18, requiresTools: true });
    try {
      pickBest(catalog(), scoresFromFixture("coding"), f, "cheapest");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(NoModelsFound);
      const counts = (e as NoModelsFound).survivorsByClause;
      expect(counts["min_context_length"]).toBe(0);
    }
  });

  it("errors on cheapest_with_floor without threshold", () => {
    const f = new ModelFilters({ requiresTools: true });
    expect(() => pickBest(catalog(), scoresFromFixture(), f, "cheapest_with_floor")).toThrow(
      /min_benchmarks/,
    );
  });

  it("errors on best_score without threshold", () => {
    expect(() => pickBest(catalog(), scoresFromFixture(), null, "best_score")).toThrow(
      /min_benchmarks/,
    );
  });

  it("errors on unknown strategy", () => {
    expect(() => pickBest(catalog(), scoresFromFixture(), null, "fanciest" as never)).toThrow(
      /unknown strategy/,
    );
  });

  it("accepts a predicate filter", () => {
    const f = pred
      .priceBelow({ prompt: 1e-6 })
      .and(pred.supportsTools())
      .and(pred.benchmarkAbove({ taskType: "coding", min: 60 }));
    const sel = pickBest(catalog(), scoresFromFixture("coding"), f, "cheapest");
    expect(sel.model.id).toBe("meta-llama/llama-3.3-70b-instruct");
  });

  it("tie-breaks by id ascending", () => {
    const m1 = new Model({ id: "aaa/zzz", name: "A", contextLength: 1, promptPrice: 1, completionPrice: 1 });
    const m2 = new Model({ id: "aaa/aaa", name: "B", contextLength: 1, promptPrice: 1, completionPrice: 1 });
    const sel = pickBest([m1, m2], [], null, "cheapest");
    expect(sel.model.id).toBe("aaa/aaa");
  });

  it("skips negative-price models in cost strategies", () => {
    const auto = new Model({
      id: "openrouter/auto",
      name: "Auto",
      contextLength: 200000,
      promptPrice: -1,
      completionPrice: -1,
      supportsTools: true,
    });
    const llama = new Model({
      id: "meta-llama/llama-3.3-70b-instruct",
      name: "Llama",
      contextLength: 131072,
      promptPrice: 1.0e-7,
      completionPrice: 3.2e-7,
      supportsTools: true,
    });
    const sel = pickBest([auto, llama], [], null, "cheapest");
    expect(sel.model.id).toBe("meta-llama/llama-3.3-70b-instruct");
  });

  it("raises NoModelsFound when all prices are negative", () => {
    const auto = new Model({
      id: "openrouter/auto",
      name: "Auto",
      contextLength: 200000,
      promptPrice: -1,
      completionPrice: -1,
      supportsTools: true,
    });
    expect(() => pickBest([auto], [], null, "cheapest")).toThrow(NoModelsFound);
  });
});
