# Provider: OpenRouter

OpenRouter is the first (and v1-only) provider for both `ModelListObtainer` and
`BenchmarkObtainer`. This document records the endpoint contracts, response
shapes, and the mapping rules used by `anypick.openrouter`.

## Endpoints

| purpose | method | URL | auth |
|---|---|---|---|
| list models | GET | `https://openrouter.ai/api/v1/models` | none (public) |
| get one model | GET | `https://openrouter.ai/api/v1/model/{author}/{slug}` | none (public) |
| list benchmarks | GET | `https://openrouter.ai/api/v1/benchmarks` | `Authorization: Bearer <key>` |

Benchmarks are rate-limited: **30 req/min per key**, **500 req/day per account**.
The models endpoints are public and unauthenticated.

Optional headers (not sent by v1) that OpenRouter uses for rankings:
`HTTP-Referer: <site url>` and `X-OpenRouter-Title: <app name>`.

> The single-model endpoint URL uses a **singular** path segment
> `/model/{author}/{slug}` (not `/models/...`). It accepts variant suffixes
> (e.g. `openai/gpt-4:free`) and resolves known slug aliases. anypick v1 does
> not use it — it always fetches the full catalog via `/models` — but it is
> available for a future single-model fast path.

## Models — `GET /api/v1/models`

### Query parameters (all optional; v1 obtainer fetches the full list)

| param | values / type | meaning |
|---|---|---|
| `offset` | int (≥0) | records to skip for pagination |
| `limit` | int (1–1000, default 500) | max records; when `offset`+`limit` omitted, full list returned |
| `category` | `programming` \| `roleplay` \| `marketing` \| `marketing/seo` \| `technology` \| `science` \| `translation` \| `legal` \| `finance` \| `health` \| `trivia` \| `academia` | filter by use case |
| `supported_parameters` | comma-separated | keep models supporting these params (e.g. `temperature,tools`) |
| `output_modalities` | comma-separated or `all` (default `text`) | filter by output modality |
| `sort` | `most-popular` \| `newest` \| `top-weekly` \| `pricing-low-to-high` \| `pricing-high-to-low` \| `context-high-to-low` \| `throughput-high-to-low` \| `latency-low-to-high` \| `intelligence-high-to-low` \| `coding-high-to-low` \| `agentic-high-to-low` \| `design-arena-elo-high-to-low` | server-side sort |
| `use_rss` | `"true"` | return results as an RSS feed |

### Envelope

```json
{ "data": [ … ], "total_count": 414, "links": { … } }
```

### Item shape (representative)

```json
{
  "id": "openai/gpt-4o",
  "canonical_slug": "openai/gpt-4o-2024-08-06",
  "hugging_face_id": "openai/gpt-4o-2024-08-06",
  "name": "OpenAI: GPT-4o",
  "description": "…",
  "context_length": 128000,
  "architecture": {
    "modality": "text+image+file->text",
    "input_modalities": ["text","image","file"],
    "output_modalities": ["text"],
    "tokenizer": "GPT",
    "instruct_type": null
  },
  "pricing": {
    "prompt": "0.0000025",
    "completion": "0.00001",
    "input_cache_read": "0.00000125"
  },
  "top_provider": { "context_length": 128000, "max_completion_tokens": 16384, "is_moderated": false },
  "supported_parameters": ["tools","tool_choice","response_format","structured_outputs","reasoning", …],
  "default_parameters": { "temperature": 1, "top_p": 0.95 },
  "reasoning": { "mandatory": false, "default_enabled": false, "supported_efforts": ["medium","low"], "default_effort": "medium" },
  "per_request_limits": null,
  "knowledge_cutoff": null,
  "expiration_date": null,
  "links": { "details": "/api/v1/models/openai/gpt-4o-2024-08-06/endpoints" }
}
```

### Pricing key variety (observed)

The `pricing` object's keys are **not uniform**. Observed key sets include:

* `{prompt, completion}`
* `{prompt, completion, input_cache_read}`
* `+ input_cache_write`, `+ input_cache_write_1h`, `+ web_search`
* `+ overrides`
* `+ image`, `+ image_output`, `+ audio`, `+ audio_output`, `+ internal_reasoning`, `+ input_audio_cache`

**Mapping rule:** `Model` uses only the three well-known keys; everything else
stays in `raw.pricing`.

* `prompt_price` = `float(pricing.get("prompt", 0))`
* `completion_price` = `float(pricing.get("completion", 0))`
* `cache_read_price` = `float(pricing.get("input_cache_read", 0))`

Free models report `"0"` strings; these parse to `0.0`.

### Capability derivation

| `Model` flag | derived from |
|---|---|
| `supports_tools` | `"tools" in supported_parameters` |
| `supports_reasoning` | `"reasoning" in supported_parameters` |
| `supports_structured_outputs` | `"structured_outputs" in supported_parameters` |

### Field mapping

| `Model` | source |
|---|---|
| `id` | `id` |
| `name` | `name` |
| `context_length` | `context_length` |
| `input_modalities` | `architecture.input_modalities` (default `[]`) |
| `output_modalities` | `architecture.output_modalities` (default `[]`) |
| `raw` | the whole item |

## Benchmarks — `GET /api/v1/benchmarks`

### Query parameters

| param | values | meaning |
|---|---|---|
| `source` | `artificial-analysis` \| `design-arena` \| `openrouter` | narrow to one feed; omitted = all |
| `task_type` | `coding` \| `intelligence` \| `agentic` | narrow by task; for artificial-analysis maps to the index, for design-arena maps to the category |
| `arena` | `models` \| `builders` \| `agents` | design-arena only; defaults to `models` when `source=design-arena` |
| `category` | `codecategories` \| `uicomponent` \| `gamedev` \| `3d` \| `dataviz` \| `image` \| `video` \| `svg` | design-arena only; one category within the arena |
| `max_results` | int (≥1) | cap the number of items; omitted = all matching |

> **`benchmark_type` is not a server query parameter.** It is a *response*
> field on `openrouter`-source items (e.g. `gpqa_diamond`,
> `tau_bench_verified_airline`). anypick narrows on it **client-side**
> (see `BenchmarkThreshold.benchmark_type` in [`filters.md`](../filters.md)).

### Envelope

```json
{ "data": [ … ], "meta": { "as_of": "…", "citation": null, "model_count": 50, "source": null, "source_url": null, "task_type": null, "version": "v1" } }
```

### Item shapes are **heterogeneous by source**

The obtainer dispatches each item to a per-source mapper.

#### `artificial-analysis`

```json
{
  "agentic_index": 58.3,
  "coding_index": 65.8,
  "display_name": "GPT-4o",
  "intelligence_index": 71.2,
  "model_permaslug": "openai/gpt-4o",
  "pricing": { "completion": "0.00001", "prompt": "0.0000025" },
  "source": "artificial-analysis"
}
```

Map → `BenchmarkScore`:

* `model_id` = `model_permaslug`
* `source` = `"artificial-analysis"`
* `task_type` = the requested `task_type` (may be `None`)
* `benchmark_type` = `None`
* `score` = index for `task_type` (`coding`→`coding_index`, `agentic`→`agentic_index`, `intelligence`→`intelligence_index`); fallback `intelligence_index` when `task_type` is `None`
* `accuracy` = `None`, `stddev` = `None`

#### `openrouter`

```json
{
  "accuracy": 0.72,
  "accuracy_stddev": 0.03,
  "avg_cost_per_task": 0.002,
  "benchmark_type": "gpqa_diamond",
  "display_name": "GPT-4o",
  "last_run_timestamp": "2026-06-03T12:00:00Z",
  "model_permaslug": "openai/gpt-4o",
  "source": "openrouter",
  "total_tasks": 300
}
```

Map → `BenchmarkScore`:

* `model_id` = `model_permaslug`
* `source` = `"openrouter"`
* `task_type` = `None` (OpenRouter's own benchmarks aren't tagged with a task_type)
* `benchmark_type` = `benchmark_type`
* `score` = `accuracy`
* `accuracy` = `accuracy`, `stddev` = `accuracy_stddev`

#### `design-arena`

Narrowing happens server-side via the `arena` (`models` | `builders` |
`agents`) and `category` (`codecategories`, `uicomponent`, `gamedev`, `3d`,
`dataviz`, `image`, `video`, `svg`) query parameters. OpenRouter does **not**
publish a fixed response item shape for this source, so
`OpenRouterBenchmarkObtainer` maps it defensively: it records the item's
`category` under `BenchmarkScore.benchmark_type` and takes the first available
numeric score field (`score`, `elo`, `arena_elo`, `category_score`). The
picker treats the score opaquely on its native scale.

## Join

`BenchmarkScore.model_id` (from `model_permaslug`) ↔ `Model.id`. When a
`model_permaslug` has no matching `Model.id`, the obtainer keeps the score (the
picker drops orphan scores silently — they can't be joined).

## Rate-limit & error handling

* **429** → exponential backoff: 0.5s, 1s, 2s (max 3 retries), then `RateLimited`.
* **401** → `BadAuth` immediately.
* other non-2xx → `ProviderError(status, body)`.

## Caching defaults

| endpoint | default TTL |
|---|---|
| `/models` | 6h |
| `/benchmarks` | 24h |

Cache keys are hashed over (endpoint, sorted query params, api-key fingerprint).
`refresh=True` bypasses the cache for a single call.
