/** Tests for OpenRouter payload parsing (offline, against fixtures). */
import { describe, it, expect } from "vitest";
import { modelsFromFixture, scoresFromFixture } from "./conftest.js";

describe("openrouter models fixture", () => {
  it("parses", () => {
    const models = modelsFromFixture();
    expect(models.length).toBe(414);
    const ids = new Set(models.map((m) => m.id));
    expect(ids.has("openai/gpt-4o")).toBe(true);
    expect(ids.has("meta-llama/llama-3.3-70b-instruct")).toBe(true);
  });

  it("maps fields", () => {
    const models = new Map(modelsFromFixture().map((m) => [m.id, m]));
    const gpt4o = models.get("openai/gpt-4o")!;
    expect(gpt4o.name).toBe("OpenAI: GPT-4o");
    expect(gpt4o.contextLength).toBe(128000);
    expect(gpt4o.promptPrice).toBe(0.0000025);
    expect(gpt4o.completionPrice).toBe(0.00001);
    expect(gpt4o.cacheReadPrice).toBe(0.00000125);
    expect(gpt4o.supportsTools).toBe(true);
    expect(gpt4o.supportsStructuredOutputs).toBe(true);
    expect(gpt4o.inputModalities).toContain("text");
    expect(gpt4o.inputModalities).toContain("image");
  });

  it("handles models with no cache_read price", () => {
    const models = new Map(modelsFromFixture().map((m) => [m.id, m]));
    const llama = models.get("meta-llama/llama-3.3-70b-instruct")!;
    expect(llama.cacheReadPrice).toBe(0);
    expect(llama.promptPrice).toBe(0.0000001);
    expect(llama.supportsTools).toBe(true);
  });

  it("preserves raw payload", () => {
    const models = new Map(modelsFromFixture().map((m) => [m.id, m]));
    const gpt4o = models.get("openai/gpt-4o")!;
    expect((gpt4o.raw as Record<string, unknown>)["id"]).toBe("openai/gpt-4o");
    expect("supported_parameters" in gpt4o.raw).toBe(true);
  });
});

describe("openrouter benchmarks fixture", () => {
  it("parses", () => {
    const scores = scoresFromFixture("coding");
    const ids = new Set(scores.map((s) => s.modelId));
    expect(ids.has("openai/gpt-4o")).toBe(true);
    expect(ids.has("meta-llama/llama-3.3-70b-instruct")).toBe(true);
  });

  it("uses task_type index for artificial-analysis", () => {
    const scores = scoresFromFixture("coding");
    const aa = scores.find(
      (s) => s.source === "artificial-analysis" && s.modelId === "openai/gpt-4o",
    )!;
    expect(aa.score).toBe(65.8);
    expect(aa.taskType).toBe("coding");
    expect(aa.benchmarkType).toBeNull();
  });

  it("falls back to intelligence_index when task_type is null", () => {
    const scores = scoresFromFixture(null);
    const aa = scores.find(
      (s) => s.source === "artificial-analysis" && s.modelId === "openai/gpt-4o",
    )!;
    expect(aa.score).toBe(71.2);
  });

  it("uses accuracy for openrouter source", () => {
    const scores = scoresFromFixture();
    const orScores = scores.filter(
      (s) => s.source === "openrouter" && s.modelId === "openai/gpt-4o",
    );
    const gpqa = orScores.find((s) => s.benchmarkType === "gpqa_diamond")!;
    expect(gpqa.score).toBe(0.72);
    expect(gpqa.accuracy).toBe(0.72);
    expect(gpqa.stddev).toBe(0.03);
    expect(gpqa.taskType).toBeNull();
  });
});
