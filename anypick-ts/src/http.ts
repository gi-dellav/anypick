/**
 * Shared HTTP + parsing helpers used by provider implementations.
 *
 * Kept in a private module so provider modules (openrouter, vercel, …) don't
 * re-implement the same auth/rate-limit/JSON dance.
 *
 * Uses the global `fetch` (Node 18+ / browsers). `request` maps 401/429/non-2xx
 * to {@link BadAuth} / {@link RateLimited} / {@link ProviderError}, with
 * optional exponential backoff on 429 / network errors.
 */

import { BadAuth, ProviderError, RateLimited } from "./errors.js";

/**
 * Parse a pricing/score string-or-number to a number; `''`/`null`/`undefined` -> 0.0.
 */
export function f(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0.0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0.0;
}

/** Dict get that tolerates non-dict values. */
export function get<T = unknown>(
  obj: unknown,
  key: string,
  fallback?: T,
): unknown | T {
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    const rec = obj as Record<string, unknown>;
    if (key in rec) return rec[key];
  }
  return fallback;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  params?: Record<string, string> | null;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface HttpResponse {
  status: number;
  body: string;
  json: () => unknown;
}

async function doFetch(
  method: string,
  url: string,
  opts: RequestOptions,
  fetchImpl: typeof fetch,
): Promise<HttpResponse> {
  const fullUrl = opts.params ? appendParams(url, opts.params) : url;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const resp = await fetchImpl(fullUrl, {
      method,
      headers: opts.headers ?? {},
      signal: controller.signal,
    });
    const text = await resp.text();
    let parsed: unknown = undefined;
    const bodyForError = text;
    return {
      status: resp.status,
      body: text,
      json: () => {
        if (parsed === undefined && text !== "") {
          parsed = JSON.parse(text);
        }
        return parsed;
      },
    };
    void bodyForError;
  } finally {
    clearTimeout(timeout);
  }
}

function appendParams(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** Fetch implementation hook (for tests). Defaults to the global `fetch`. */
export let _fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);

/** Override the fetch implementation (used by tests to monkeypatch). */
export function setFetchImpl(fn: typeof fetch): void {
  _fetchImpl = fn;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Perform an HTTP request with auth/rate-limit error mapping + backoff.
 *
 * `maxRetries` retries on 429 / network errors with exponential backoff
 * (0.5s, 1s, 2s, …). 401 -> `BadAuth` immediately; other non-2xx ->
 * `ProviderError`. Returns the parsed JSON body.
 */
export async function request(
  method: string,
  url: string,
  opts: RequestOptions = {},
): Promise<unknown> {
  const maxRetries = opts.maxRetries ?? 0;
  let backoff = 0.5;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let resp: HttpResponse;
    try {
      resp = await doFetch(method, url, opts, _fetchImpl);
    } catch (exc) {
      lastError = exc instanceof Error ? exc : new Error(String(exc));
      if (attempt < maxRetries) {
        await sleep(backoff * 1000);
        backoff *= 2;
        continue;
      }
      throw new ProviderError(0, `network error: ${lastError.message}`);
    }

    if (resp.status === 401) throw new BadAuth();
    if (resp.status === 429) {
      if (attempt < maxRetries) {
        await sleep(backoff * 1000);
        backoff *= 2;
        continue;
      }
      throw new RateLimited();
    }
    if (resp.status >= 400) {
      throw new ProviderError(resp.status, resp.body);
    }
    try {
      return resp.json();
    } catch (exc) {
      throw new ProviderError(
        resp.status,
        `invalid JSON: ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
  }

  // Exhausted retries on 429/network without a definitive outcome.
  if (lastError !== null) {
    throw new ProviderError(0, `network error after retries: ${lastError.message}`);
  }
  throw new RateLimited();
}
