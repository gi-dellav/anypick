/** Tests for the filter DSL and applyFilters. */
import { describe, it, expect } from "vitest";
import { BenchmarkScore, Model, applyFilters, pred } from "../src/index.js";
import { BenchmarkThreshold, ModelFilters } from "../src/filter.js";
import { modelsFromFixture, scoresFromFixture } from "./conftest.js";

describe("filters: basics", () => {
  it("no filter keeps all", () => {
    expect(applyFilters(modelsFromFixture(), scoresFromFixture(), null).length).toBe(
      modelsFromFixture().length,
    );
  });

  it("empty spec keeps all", () => {
    expect(applyFilters(modelsFromFixture(), scoresFromFixture(), new ModelFilters()).length).toBe(
      modelsFromFixture().length,
    );
  });

  it("max_prompt_price bounds prompt price", () => {
    const f = new ModelFilters({ maxPromptPrice: 1e-6 });
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture(), f);
    for (const m of survivors) expect(m.promptPrice).toBeLessThanOrEqual(1e-6);
    expect(new Set(survivors.map((m) => m.id)).has("meta-llama/llama-3.3-70b-instruct")).toBe(true);
  });

  it("min_context_length bounds context", () => {
    const f = new ModelFilters({ minContextLength: 200_000 });
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture(), f);
    for (const m of survivors) expect(m.contextLength).toBeGreaterThanOrEqual(200_000);
    expect(new Set(survivors.map((m) => m.id)).has("qwen/qwen3.8-27b")).toBe(true);
  });

  it("modalities_in is a superset test", () => {
    const f = new ModelFilters({ modalitiesIn: ["image"] });
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture(), f);
    for (const m of survivors) expect(m.inputModalities).toContain("image");
    expect(new Set(survivors.map((m) => m.id)).has("openai/gpt-4o")).toBe(true);
  });

  it("requires_tools requires the flag", () => {
    const f = new ModelFilters({ requiresTools: true });
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture(), f);
    for (const m of survivors) expect(m.supportsTools).toBe(true);
  });

  it("exclude_ids drops a model", () => {
    const f = new ModelFilters({ excludeIds: ["openai/gpt-4o"] });
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture(), f);
    expect(new Set(survivors.map((m) => m.id)).has("openai/gpt-4o")).toBe(false);
  });
});

describe("filters: benchmarks", () => {
  it("min_benchmarks drops scoreless models", () => {
    const f = new ModelFilters({
      minBenchmarks: [new BenchmarkThreshold({ taskType: "coding", min: 60 })],
    });
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture("coding"), f);
    const ids = new Set(survivors.map((m) => m.id));
    expect(ids.has("openai/gpt-4o")).toBe(true);
    expect(ids.has("meta-llama/llama-3.3-70b-instruct")).toBe(true);
    expect(ids.has("qwen/qwen3.8-27b")).toBe(true);
    expect(ids.has("deepseek/deepseek-v4-pro-0813")).toBe(false);
  });

  it("benchmark scope without bound keeps only scored models", () => {
    const f = new ModelFilters({
      minBenchmarks: [new BenchmarkThreshold({ taskType: "coding" })],
    });
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture("coding"), f);
    const ids = new Set(survivors.map((m) => m.id));
    expect(ids.has("openai/gpt-4o")).toBe(true);
    expect(ids.has("deepseek/deepseek-v4-pro-0813")).toBe(false);
  });

  it("benchmark source scope with accuracy bound", () => {
    const f = new ModelFilters({
      minBenchmarks: [
        new BenchmarkThreshold({
          source: "openrouter",
          benchmarkType: "gpqa_diamond",
          min: 0.5,
        }),
      ],
    });
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture(), f);
    const ids = new Set(survivors.map((m) => m.id));
    expect(ids.has("openai/gpt-4o")).toBe(true);
    expect(ids.has("meta-llama/llama-3.3-70b-instruct")).toBe(false);
  });

  it("min_benchmarks list is a logical AND", () => {
    const f = new ModelFilters({
      minBenchmarks: [
        new BenchmarkThreshold({ taskType: "coding", min: 60 }),
        new BenchmarkThreshold({ taskType: "coding", min: 70 }),
      ],
    });
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture("coding"), f);
    expect(new Set(survivors.map((m) => m.id))).toEqual(new Set(["qwen/qwen3.8-27b"]));
  });

  it("max_benchmarks list works", () => {
    const f = new ModelFilters({
      maxBenchmarks: [
        new BenchmarkThreshold({
          source: "openrouter",
          benchmarkType: "gpqa_diamond",
          max: 0.5,
        }),
      ],
    });
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture(), f);
    const ids = new Set(survivors.map((m) => m.id));
    expect(ids.has("meta-llama/llama-3.3-70b-instruct")).toBe(true);
    expect(ids.has("openai/gpt-4o")).toBe(false);
  });
});

describe("filters: tier-1 additions", () => {
  it("include_ids whitelist", () => {
    const want = ["openai/gpt-4o", "meta-llama/llama-3.3-70b-instruct"];
    const f = new ModelFilters({ includeIds: want });
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture(), f);
    expect(new Set(survivors.map((m) => m.id))).toEqual(new Set(want));
  });

  it("include_makers whitelist", () => {
    const f = new ModelFilters({ includeMakers: ["openai", "qwen"] });
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture(), f);
    for (const m of survivors)
      expect(["openai", "qwen"]).toContain(m.id.split("/", 1)[0]);
    const ids = new Set(survivors.map((m) => m.id));
    expect(ids.has("openai/gpt-4o")).toBe(true);
    expect(ids.has("qwen/qwen3.8-27b")).toBe(true);
    expect(ids.has("google/gemini-flash-1.5")).toBe(false);
  });

  it("include_makers drops makerless ids", () => {
    const models = [
      new Model({ id: "lonely", name: "x", contextLength: 1 }),
      new Model({ id: "openai/gpt-4o", name: "g", contextLength: 1 }),
    ];
    const f = new ModelFilters({ includeMakers: ["openai"] });
    const survivors = applyFilters(models, [], f);
    expect(new Set(survivors.map((m) => m.id))).toEqual(new Set(["openai/gpt-4o"]));
  });

  it("exclude_makers keeps makerless ids", () => {
    const models = [
      new Model({ id: "lonely", name: "x", contextLength: 1 }),
      new Model({ id: "openai/gpt-4o", name: "g", contextLength: 1 }),
    ];
    const f = new ModelFilters({ excludeMakers: ["openai"] });
    const survivors = applyFilters(models, [], f);
    expect(new Set(survivors.map((m) => m.id))).toEqual(new Set(["lonely"]));
  });

  it("min_prompt_price floor", () => {
    const f = new ModelFilters({ minPromptPrice: 1e-6 });
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture(), f);
    for (const m of survivors) expect(m.promptPrice).toBeGreaterThanOrEqual(1e-6);
  });

  it("max_context_length", () => {
    const f = new ModelFilters({ maxContextLength: 200_000 });
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture(), f);
    for (const m of survivors) expect(m.contextLength).toBeLessThanOrEqual(200_000);
    expect(new Set(survivors.map((m) => m.id)).has("qwen/qwen3.8-27b")).toBe(false);
    expect(new Set(survivors.map((m) => m.id)).has("openai/gpt-4o")).toBe(true);
  });

  it("modalities_exactly", () => {
    const f = new ModelFilters({ modalitiesExactly: ["text", "image"] });
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture(), f);
    for (const m of survivors)
      expect(new Set(m.inputModalities)).toEqual(new Set(["text", "image"]));
    expect(new Set(survivors.map((m) => m.id)).has("meta/muse-glimmer-30b")).toBe(true);
    expect(new Set(survivors.map((m) => m.id)).has("deepseek/deepseek-v4-pro-0813")).toBe(false);
  });

  it("excludes_modalities drops image-capable", () => {
    const f = new ModelFilters({ excludesModalities: ["image"] });
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture(), f);
    for (const m of survivors) expect(m.inputModalities).not.toContain("image");
    expect(new Set(survivors.map((m) => m.id)).has("openai/gpt-4o")).toBe(false);
  });

  it("requires_tools False forbids", () => {
    const f = new ModelFilters({ requiresTools: false });
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture(), f);
    for (const m of survivors) expect(m.supportsTools).toBe(false);
    expect(survivors.length).toBeLessThan(modelsFromFixture().length);
  });
});

describe("filters: predicate combinators", () => {
  it("and-chain selects the right model", () => {
    const f = pred
      .priceBelow({ prompt: 1e-6 })
      .and(pred.contextAtLeast(128_000))
      .and(pred.supportsTools())
      .and(pred.benchmarkAbove({ taskType: "coding", min: 60 }));
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture("coding"), f);
    const ids = new Set(survivors.map((m) => m.id));
    expect(ids.has("meta-llama/llama-3.3-70b-instruct")).toBe(true);
    expect(ids.has("openai/gpt-4o")).toBe(false);
  });

  it("negation forbids tools", () => {
    const f = pred.supportsTools().not();
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture(), f);
    for (const m of survivors) expect(m.supportsTools).toBe(false);
  });

  it("or combinator", () => {
    const f = pred.supportsTools().or(pred.supportsStructuredOutputs());
    const survivors = applyFilters(modelsFromFixture(), scoresFromFixture(), f);
    for (const m of survivors)
      expect(m.supportsTools || m.supportsStructuredOutputs).toBe(true);
  });

  it("pred id_in / maker_in", () => {
    const a = applyFilters(
      modelsFromFixture(),
      scoresFromFixture(),
      pred.idIn(["openai/gpt-4o", "qwen/qwen3.8-27b"]),
    );
    expect(new Set(a.map((m) => m.id))).toEqual(
      new Set(["openai/gpt-4o", "qwen/qwen3.8-27b"]),
    );
    const b = applyFilters(
      modelsFromFixture(),
      scoresFromFixture(),
      pred.makerIn(["openai"]),
    );
    for (const m of b) expect(m.id.startsWith("openai/")).toBe(true);
  });
});
