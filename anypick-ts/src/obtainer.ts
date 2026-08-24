/**
 * Obtainer interfaces and caching wrappers.
 *
 * An *obtainer* is the only piece of anypick that talks to a provider. It
 * translates the provider's raw payload into the normalized
 * {@link Model} / {@link BenchmarkScore} structs.
 *
 * Caching is a wrapper, not a concern of the obtainer itself, so a
 * `CachedModelObtainer` can wrap any `ModelListObtainer`.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BenchmarkScore, type BenchmarkScoreData, Model, type ModelData } from "./model.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ListModelsOptions extends Record<string, unknown> {
  refresh?: boolean;
}

export interface ListBenchmarksOptions extends Record<string, unknown> {
  source?: string | null;
  taskType?: string | null;
  benchmarkType?: string | null;
  refresh?: boolean;
}

/** Produces the full model catalog as normalized `Model` records. */
export interface ModelListObtainer {
  listModels(opts?: ListModelsOptions): Promise<Model[]>;
}

/** Produces benchmark scores, optionally narrowed. */
export interface BenchmarkObtainer {
  listBenchmarks(opts?: ListBenchmarksOptions): Promise<BenchmarkScore[]>;
}

export type ObtainerPair = [ModelListObtainer, BenchmarkObtainer];

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** A tiny TTL cache. */
export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttl?: number | null): Promise<void>;
}

/** Stable hash over the parts used to build a cache key. */
export function hashKey(...parts: unknown[]): string {
  const blob = JSON.stringify(parts, (_k, v) =>
    typeof v === "bigint" ? String(v) : v,
  );
  return createHash("sha256").update(blob, "utf8").digest("hex");
}

/** In-process TTL cache. Lost on restart. */
export class MemoryCache implements Cache {
  private store = new Map<string, { value: unknown; expires: number | null }>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expires !== null && Date.now() >= entry.expires) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set(key: string, value: unknown, ttl?: number | null): Promise<void> {
    const expires = ttl != null ? Date.now() + ttl * 1000 : null;
    this.store.set(key, { value, expires });
  }
}

/** Filesystem TTL cache. Default location: `~/.cache/anypick`. */
export class FileCache implements Cache {
  readonly dir: string;

  constructor(dir: string | null = null) {
    this.dir = dir ?? join(homedir(), ".cache", "anypick");
  }

  private path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  async get<T>(key: string): Promise<T | null> {
    const path = this.path(key);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return null;
    }
    let envelope: { value?: unknown; expires?: number | null };
    try {
      envelope = JSON.parse(text);
    } catch {
      return null;
    }
    const expires = envelope.expires ?? null;
    if (expires !== null && Date.now() >= expires) {
      await rm(path, { force: true });
      return null;
    }
    return (envelope.value ?? null) as T | null;
  }

  async set(key: string, value: unknown, ttl?: number | null): Promise<void> {
    const path = this.path(key);
    const envelope = {
      value,
      expires: ttl != null ? Date.now() + ttl * 1000 : null,
    };
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(path, JSON.stringify(envelope), "utf8");
    } catch {
      // Cache is best-effort; never fail a call because the disk is full.
    }
  }
}

// ---------------------------------------------------------------------------
// Cached wrappers
// ---------------------------------------------------------------------------

/**
 * A `BenchmarkObtainer` that always returns no scores.
 *
 * Used to wire providers that expose a model catalog but no benchmark feed
 * (e.g. the Vercel AI Gateway models endpoint). Strategies that need scores
 * will simply find none.
 */
export class NoopBenchmarkObtainer implements BenchmarkObtainer {
  async listBenchmarks(_opts?: ListBenchmarksOptions): Promise<BenchmarkScore[]> {
    return [];
  }
}

/** Wraps a `ModelListObtainer` with a TTL cache. */
export class CachedModelObtainer implements ModelListObtainer {
  constructor(
    readonly inner: ModelListObtainer,
    readonly cache: Cache,
    readonly ttl: number = 6 * 3600,
  ) {}

  async listModels(opts: ListModelsOptions = {}): Promise<Model[]> {
    const { refresh, ...rest } = opts;
    const key = hashKey("models", this.inner.constructor.name, rest);
    if (!refresh) {
      const cached = await this.cache.get<ModelData[]>(key);
      if (cached) return cached.map((d) => Model.fromJSON(d));
    }
    const value = await this.inner.listModels(rest);
    await this.cache.set(key, value.map((m) => m.toJSON()), this.ttl);
    return value;
  }
}

/** Wraps a `BenchmarkObtainer` with a TTL cache. */
export class CachedBenchmarkObtainer implements BenchmarkObtainer {
  constructor(
    readonly inner: BenchmarkObtainer,
    readonly cache: Cache,
    readonly ttl: number = 24 * 3600,
  ) {}

  async listBenchmarks(opts: ListBenchmarksOptions = {}): Promise<BenchmarkScore[]> {
    const { refresh, source, taskType, benchmarkType, ...rest } = opts;
    const key = hashKey(
      "benchmarks",
      this.inner.constructor.name,
      source ?? null,
      taskType ?? null,
      benchmarkType ?? null,
      rest,
    );
    if (!refresh) {
      const cached = await this.cache.get<BenchmarkScoreData[]>(key);
      if (cached) return cached.map((d) => BenchmarkScore.fromJSON(d));
    }
    const clean: ListBenchmarksOptions = { ...rest };
    if (source !== undefined) clean.source = source ?? null;
    if (taskType !== undefined) clean.taskType = taskType ?? null;
    if (benchmarkType !== undefined) clean.benchmarkType = benchmarkType ?? null;
    const value = await this.inner.listBenchmarks(clean);
    await this.cache.set(key, value.map((s) => s.toJSON()), this.ttl);
    return value;
  }
}

