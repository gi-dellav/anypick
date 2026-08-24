/** Tests for the Vercel AI Gateway payload parsing (offline, against fixtures). */
import { describe, it, expect, beforeEach } from "vitest";
import { loadFixture } from "./conftest.js";
import { anypick, ModelFilters, NoModelsFound, NoopBenchmarkObtainer } from "../src/index.js";
import { VercelModelObtainer, mapModel } from "../src/vercel.js";
import { setFetchImpl } from "../src/http.js";

function models() {
  const payload = loadFixture("vercel_models.json");
  return (payload.data as Record<string, unknown>[]).map(mapModel);
}

function fakeFetch() {
  const payload = loadFixture("vercel_models.json");
  const resp = {
    status: 200,
    text: async () => JSON.stringify(payload),
  } as Response;
  return async () => Promise.resolve(resp);
}

describe("vercel models fixture", () => {
  it("parses", () => {
    const m = models();
    const ids = new Set(m.map((x) => x.id));
    expect(ids).toEqual(
      new Set([
        "google/gemini-3.1-pro-preview",
        "openai/gpt-5.6-sol",
        "anthropic/claude-opus-4.3",
        "black-forest-labs/flux-pro-1.1",
        "openai/text-embedding-3-large",
        "meta/llama-4-free",
      ]),
    );
  });

  it("maps language model fields", () => {
    const m = new Map(models().map((x) => [x.id, x]));
    const gemini = m.get("google/gemini-3.1-pro-preview")!;
    expect(gemini.name).toBe("Gemini 3.1 Pro Preview");
    expect(gemini.contextLength).toBe(1_000_000);
    expect(gemini.promptPrice).toBe(0.000002);
    expect(gemini.completionPrice).toBe(0.000012);
    expect(gemini.cacheReadPrice).toBe(0.0000002);
    expect(gemini.supportsTools).toBe(true);
    expect(gemini.supportsReasoning).toBe(true);
    expect(gemini.supportsStructuredOutputs).toBe(false);
    expect(gemini.inputModalities).toContain("text");
    expect(gemini.inputModalities).toContain("image");
    expect(gemini.inputModalities).toContain("file");
    expect(gemini.outputModalities).toEqual(["text"]);
  });

  it("parses pricing without cache_read", () => {
    const m = new Map(models().map((x) => [x.id, x]));
    const gpt = m.get("openai/gpt-5.6-sol")!;
    expect(gpt.cacheReadPrice).toBe(0);
    expect(gpt.promptPrice).toBe(0.000005);
    expect(gpt.supportsReasoning).toBe(true);
    expect(gpt.supportsTools).toBe(true);
    expect(gpt.inputModalities).toEqual(["text"]);
  });

  it("parses free models to zero", () => {
    const m = new Map(models().map((x) => [x.id, x]));
    const llama = m.get("meta/llama-4-free")!;
    expect(llama.promptPrice).toBe(0);
    expect(llama.completionPrice).toBe(0);
    expect(llama.supportsTools).toBe(true);
    expect(llama.supportsReasoning).toBe(false);
  });

  it("maps image models", () => {
    const m = new Map(models().map((x) => [x.id, x]));
    const flux = m.get("black-forest-labs/flux-pro-1.1")!;
    expect(flux.outputModalities).toEqual(["image"]);
    expect(flux.promptPrice).toBe(0);
    expect(flux.completionPrice).toBe(0);
    expect(flux.contextLength).toBe(0);
    expect(flux.supportsTools).toBe(false);
    expect((flux.raw as Record<string, unknown>)["pricing"]).toMatchObject({
      image: "0.04",
    });
  });

  it("embedding models have no output modality", () => {
    const m = new Map(models().map((x) => [x.id, x]));
    const emb = m.get("openai/text-embedding-3-large")!;
    expect(emb.outputModalities).toEqual([]);
    expect(emb.inputModalities).toEqual(["text"]);
    expect(emb.promptPrice).toBe(0.00000013);
    expect(emb.completionPrice).toBe(0);
  });

  it("preserves raw payload", () => {
    const m = new Map(models().map((x) => [x.id, x]));
    const gemini = m.get("google/gemini-3.1-pro-preview")!;
    expect((gemini.raw as Record<string, unknown>)["id"]).toBe(
      "google/gemini-3.1-pro-preview",
    );
    expect((gemini.raw as Record<string, unknown>)["type"]).toBe("language");
    expect("tags" in gemini.raw).toBe(true);
  });
});

describe("vercel obtainer", () => {
  beforeEach(() => {
    setFetchImpl(fakeFetch() as unknown as typeof fetch);
  });

  it("parses the fetched JSON envelope", async () => {
    const obt = new VercelModelObtainer({ apiKey: "fake" });
    const models = await obt.listModels();
    expect(models.length).toBe(6);
  });

  it("sends Bearer when keyed", async () => {
    let captured: Record<string, string> | undefined;
    setFetchImpl((async (_url: any, init?: any) => {
      captured = init?.headers;
      const resp = { status: 200, text: async () => JSON.stringify(loadFixture("vercel_models.json")) } as Response;
      return resp;
    }) as unknown as typeof fetch);
    await new VercelModelObtainer({ apiKey: "sk-test" }).listModels();
    expect(captured?.["Authorization"]).toBe("Bearer sk-test");
  });

  it("omits Authorization when no key", async () => {
    let captured: Record<string, string> | undefined;
    setFetchImpl((async (_url: any, init?: any) => {
      captured = init?.headers;
      const resp = { status: 200, text: async () => JSON.stringify(loadFixture("vercel_models.json")) } as Response;
      return resp;
    }) as unknown as typeof fetch);
    delete process.env["VERCEL_AI_GATEWAY_API_KEY"];
    await new VercelModelObtainer().listModels();
    expect("Authorization" in (captured ?? {})).toBe(false);
  });
});

describe("anypick vercel provider", () => {
  beforeEach(() => {
    setFetchImpl(fakeFetch() as unknown as typeof fetch);
  });

  it("picks cheapest tool-capable language model", async () => {
    const sel = await anypick({
      filters: new ModelFilters({
        minContextLength: 128_000,
        requiresTools: true,
      }),
      strategy: "cheapest",
      obtainer: [new VercelModelObtainer({ apiKey: null }), new NoopBenchmarkObtainer()],
      cache: false,
    });
    expect(sel.model.id).toBe("meta/llama-4-free");
    expect(sel.promptPrice).toBe(0);
    expect(sel.score).toBeNull();
  });

  it("supports obtainer='vercel' wiring", async () => {
    delete process.env["VERCEL_AI_GATEWAY_API_KEY"];
    const sel = await anypick({
      filters: new ModelFilters({ minContextLength: 128_000, requiresTools: true }),
      strategy: "cheapest",
      obtainer: "vercel",
      cache: false,
    });
    expect(sel.model.id).toBe("meta/llama-4-free");
  });

  it("raises NoModelsFound when filtered empty", async () => {
    await expect(
      anypick({
        filters: new ModelFilters({ minContextLength: 10 ** 18 }),
        strategy: "cheapest",
        obtainer: "vercel",
        cache: false,
      }),
    ).rejects.toBeInstanceOf(NoModelsFound);
  });
});
