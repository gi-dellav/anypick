# Architecture & shared implementation details

This document describes the internal contract shared by **every** provider
implementation and by the filter/pick layers. Provider-specific quirks live in
[`providers/openrouter.md`](providers/openrouter.md). The public API is
documented in [`api-reference.md`](api-reference.md).

## Goals

1. Choose an LLM from a *federated* pool using filters over **capabilities**,
   **pricing** and **benchmarks**, then pick the best survivor via a strategy.
2. Be provider-agnostic: adding a new model directory or benchmark feed must
   not touch the filter or pick layers.
3. Select only — never call/chat the chosen model.

## Layering

```
L4  Convenience   anypick(filters, strategy, obtainer=...)
L3  Picker        pick_best(models, scores, filters, strategy) -> Selection
L2  Filters       ModelFilters spec  +  pred.* combinators  -> Predicate
L1  Obtainers     ModelListObtainer / BenchmarkObtainer  (Protocols)
    + Normalized types: Model, BenchmarkScore
```

Dependencies point downward only. L1 produces the two normalized structs;
L2/L3 operate on those structs and nothing else.

## Normalized currency

All of L2–L4 speak exclusively in two structs. A provider implementation's
first job is to translate its raw payload into these.

### `Model`

| field | type | notes |
|---|---|---|
| `id` | `str` | canonical id, e.g. `"openai/gpt-4o"`; join key |
| `name` | `str` | human label |
| `context_length` | `int` | max tokens in |
| `input_modalities` | `list[str]` | `["text","image","audio",...]` |
| `output_modalities` | `list[str]` | |
| `prompt_price` | `float` | USD/token |
| `completion_price` | `float` | USD/token |
| `cache_read_price` | `float` | USD/token; `0.0` if unknown |
| `supports_tools` | `bool` | derived from capability params |
| `supports_reasoning` | `bool` | derived |
| `supports_structured_outputs` | `bool` | derived |
| `raw` | `dict` | original payload, kept for power users |

### `BenchmarkScore`

| field | type | notes |
|---|---|---|
| `model_id` | `str` | joins to `Model.id` |
| `source` | `str` | e.g. `"artificial-analysis"`, `"openrouter"` |
| `task_type` | `str \| None` | `"coding" \| "intelligence" \| "agentic"` |
| `benchmark_type` | `str \| None` | response field, e.g. `"gpqa_diamond"`, `"tau_bench_verified_airline"` |
| `score` | `float` | the single comparable number for this source |
| `accuracy` | `float \| None` | raw accuracy when the source exposes it |
| `stddev` | `float \| None` | |
| `raw` | `dict` | original payload |

### Why `score` is **not** re-normalized across sources

The artificial-analysis feed reports indices on a ~0–100 scale
(`intelligence_index`, `coding_index`, `agentic_index`). OpenRouter's own
benchmarks report `accuracy` on a 0–1 scale. Mapping both onto one axis in v1
would either compress the indices or inflate the accuracies, and — worse —
would hide *which* number drove a pick. So `score` is **source-specific**, and
benchmark thresholds must be expressed per source (see
[`filters.md`](filters.md) §"Benchmark-aware filters"). This is revisitable in
v2 behind an explicit opt-in normalizer.

### Score derivation rule (per source)

A `BenchmarkObtainer` must produce `score` as follows:

| source | `score` derivation |
|---|---|
| `artificial-analysis` | the index matching the requested `task_type` (`coding`→`coding_index`, `agentic`→`agentic_index`, `intelligence`→`intelligence_index`); if `task_type` is `None`, fall back to `intelligence_index`. |
| `openrouter` | `score = accuracy`. `benchmark_type` and `accuracy`/`stddev` are preserved. |
| `design-arena` | category → score, per the provider's category map. |

## Obtainer contracts

```python
class ModelListObtainer(Protocol):
    def list_models(self, **opts) -> list[Model]: ...

class BenchmarkObtainer(Protocol):
    def list_benchmarks(
        self, *, source=None, task_type=None, benchmark_type=None, **opts
    ) -> list[BenchmarkScore]: ...
```

Two responsibilities only:

* `ModelListObtainer.list_models()` → the full catalog as `Model`s.
* `BenchmarkObtainer.list_benchmarks(...)` → `BenchmarkScore`s, optionally
  narrowed by `source` / `task_type` / `benchmark_type`. Narrowing is a hint,
  not a guarantee: the picker re-filters on these fields regardless.

HTTP, auth, pagination, parsing, and per-source score derivation are the
implementation's private concern.

## Join model

`BenchmarkScore.model_id` joins to `Model.id`. A model may carry **zero, one,
or many** scores (multiple sources / task types / benchmark types). The picker
groups scores by `model_id` and treats "no matching score" as **unknown**, not
**zero** — see the filter semantics below.

## Caching

Caching is a wrapper, never a concern of the obtainer itself:

```python
class Cache(Protocol):
    def get(self, key: str): ...
    def set(self, key: str, value, ttl: float | None = None): ...

CachedModelObtainer(inner, cache, ttl=6*3600)
CachedBenchmarkObtainer(inner, cache, ttl=24*3600)
```

Defaults reflect cost:

| endpoint | auth | rate limit | default TTL |
|---|---|---|---|
| models | none | none | 6h |
| benchmarks | Bearer key | 30 req/min, 500/day per key | 24h |

A 429 from the benchmarks endpoint triggers exponential backoff (capped at
3 retries) before surfacing `RateLimited`. A 401 surfaces `BadAuth`
immediately. The default `FileCache` lives under `~/.cache/anypick`.

## Errors

| error | raised when |
|---|---|
| `NoModelsFound` | the filter set is empty. Carries per-clause surviving counts. |
| `BadAuth` | a keyed endpoint returns 401. |
| `RateLimited` | a keyed endpoint returns 429 after backoff is exhausted. |
| `ProviderError` | any other non-2xx from a provider. Carries status + body. |

## Determinism

`pick_best` tie-breaks by `Model.id`. Filtering preserves the provider's
original ordering (stable). Caches are keyed by a hash of the *call* (endpoint
+ query params + api-key fingerprint), so identical calls hit the cache and
identical inputs produce identical selections.

## What v1 does **not** do

* Call/chat the chosen model.
* Background-refresh caches. `refresh=True` forces a refetch; that's it.
* Normalize benchmark scores across sources.
* Federate multiple providers at once. One obtainer pair per `anypick()` call.
