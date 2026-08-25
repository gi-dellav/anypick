/** Tests for the obtainer interfaces, cache, and the anypick() wiring. */
import { describe, it, expect } from "vitest";
import {
  BenchmarkScore,
  BenchmarkThreshold,
  FileCache,
  MemoryCache,
  Model,
  ModelFilters,
  NoModelsFound,
  anypick,
} from "../src/index.js";
import {
  CachedBenchmarkObtainer,
  CachedModelObtainer,
  type BenchmarkObtainer,
  type ModelListObtainer,
} from "../src/obtainer.js";
import { modelsFromFixture, scoresFromFixture } from "./conftest.js";

class FakeModelObtainer implements ModelListObtainer {
  calls = 0;
  constructor(readonly models: Model[]) {}
  async listModels(): Promise<Model[]> {
    this.calls++;
    return [...this.models];
  }
}

class FakeBenchmarkObtainer implements BenchmarkObtainer {
  calls = 0;
  constructor(readonly scores: BenchmarkScore[]) {}
  async listBenchmarks(
    opts: { source?: string | null; taskType?: string | null; benchmarkType?: string | null } = {},
  ): Promise<BenchmarkScore[]> {
    this.calls++;
    let out = [...this.scores];
    if (opts.source) out = out.filter((s) => s.source === opts.source);
    if (opts.taskType) out = out.filter((s) => s.taskType === opts.taskType);
    if (opts.benchmarkType)
      out = out.filter((s) => s.benchmarkType === opts.benchmarkType);
    return out;
  }
}

describe("anypick() wiring", () => {
  it("uses fake obtainers and picks via cheapest_with_floor", async () => {
    const models = modelsFromFixture();
    const scores = scoresFromFixture("coding");
    const sel = await anypick({
      filters: new ModelFilters({
        requiresTools: true,
        minContextLength: 128_000,
        minBenchmarks: [new BenchmarkThreshold({ taskType: "coding", min: 60 })],
      }),
      strategy: "cheapest_with_floor",
      obtainer: [new FakeModelObtainer(models), new FakeBenchmarkObtainer(scores)],
      cache: false,
    });
    expect(sel.model.id).toBe("meta-llama/llama-3.3-70b-instruct");
    expect(sel.score!.score).toBe(60.0);
  });

  it("does not fetch benchmarks for cheapest without a benchmark clause", async () => {
    const models = modelsFromFixture();
    const bo = new FakeBenchmarkObtainer([]);
    const sel = await anypick({
      filters: new ModelFilters({ requiresTools: true, minContextLength: 128_000 }),
      strategy: "cheapest",
      obtainer: [new FakeModelObtainer(models), bo],
      cache: false,
    });
    expect(bo.calls).toBe(0);
    expect(sel.score).toBeNull();
    expect(sel.model.promptPrice).toBeGreaterThanOrEqual(0);
  });

  it("raises NoModelsFound when filtered empty", async () => {
    const models = modelsFromFixture();
    const scores = scoresFromFixture();
    await expect(
      anypick({
        filters: new ModelFilters({ minContextLength: 10 ** 18 }),
        strategy: "cheapest",
        obtainer: [new FakeModelObtainer(models), new FakeBenchmarkObtainer(scores)],
        cache: false,
      }),
    ).rejects.toBeInstanceOf(NoModelsFound);
  });

  it("raises on unknown obtainer", async () => {
    await expect(
      anypick({ obtainer: "mintlify" as never, cache: false }),
    ).rejects.toThrow(/unknown obtainer/);
  });

  it("uses a custom modelObtainer with the default benchmark obtainer", async () => {
    const models = modelsFromFixture();
    const sel = await anypick({
      filters: new ModelFilters({ requiresTools: true, minContextLength: 128_000 }),
      strategy: "cheapest",
      modelObtainer: new FakeModelObtainer(models),
      cache: false,
    });
    expect(sel.model.id).toBe("cohere/north-mini-code:free");
  });

  it("uses a custom benchmarkObtainer with the default model obtainer", async () => {
    const models = modelsFromFixture();
    const scores = scoresFromFixture("coding");
    const sel = await anypick({
      filters: new ModelFilters({
        requiresTools: true,
        minContextLength: 128_000,
        minBenchmarks: [new BenchmarkThreshold({ taskType: "coding", min: 60 })],
      }),
      strategy: "cheapest_with_floor",
      benchmarkObtainer: new FakeBenchmarkObtainer(scores),
      modelObtainer: new FakeModelObtainer(models),
      cache: false,
    });
    expect(sel.model.id).toBe("meta-llama/llama-3.3-70b-instruct");
    expect(sel.score!.score).toBe(60.0);
  });

  it("custom obtainers are wrapped when a cache is enabled", async () => {
    const models = modelsFromFixture();
    const mo = new FakeModelObtainer(models);
    const bo = new FakeBenchmarkObtainer([]);
    await anypick({
      filters: new ModelFilters({ requiresTools: true, minContextLength: 128_000 }),
      strategy: "cheapest",
      modelObtainer: mo,
      benchmarkObtainer: bo,
      cache: new MemoryCache(),
    });
    expect(mo.calls).toBe(1);
  });
});

describe("cache", () => {
  it("memory cache avoids a second fetch", async () => {
    const models = modelsFromFixture();
    const scores = scoresFromFixture();
    const cache = new MemoryCache();
    const mo = new FakeModelObtainer(models);
    const bo = new FakeBenchmarkObtainer(scores);
    const cmo = new CachedModelObtainer(mo, cache, 3600);
    const cbo = new CachedBenchmarkObtainer(bo, cache, 3600);

    const m1 = await cmo.listModels();
    expect(mo.calls).toBe(1);
    const m2 = await cmo.listModels();
    expect(mo.calls).toBe(1);
    expect(m2.length).toBe(m1.length);

    const s1 = await cbo.listBenchmarks();
    expect(bo.calls).toBe(1);
    const s2 = await cbo.listBenchmarks();
    expect(bo.calls).toBe(1);
    expect(s2.length).toBe(s1.length);
  });

  it("refresh bypasses the cache", async () => {
    const models = modelsFromFixture();
    const cache = new MemoryCache();
    const mo = new FakeModelObtainer(models);
    const cmo = new CachedModelObtainer(mo, cache, 3600);
    await cmo.listModels();
    expect(mo.calls).toBe(1);
    await cmo.listModels({ refresh: true });
    expect(mo.calls).toBe(2);
  });

  it("file cache roundtrips across obtainer instances", async () => {
    const models = modelsFromFixture();
    const tmp = `${import.meta.dirname}/fixtures/.cache-test`;
    const cache = new FileCache(tmp);
    const mo = new FakeModelObtainer(models);
    const cmo = new CachedModelObtainer(mo, cache, 3600);
    await cmo.listModels();

    const mo2 = new FakeModelObtainer(models);
    const cmo2 = new CachedModelObtainer(mo2, cache, 3600);
    const out = await cmo2.listModels();
    expect(mo2.calls).toBe(0);
    expect(out.length).toBe(models.length);

    // cleanup
    const { rm } = await import("node:fs/promises");
    await rm(tmp, { recursive: true, force: true });
  });
});
