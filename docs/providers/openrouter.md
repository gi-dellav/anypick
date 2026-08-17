# Provider: OpenRouter

OpenRouter is the first (and v1-only) provider for both `ModelListObtainer` and
`BenchmarkObtainer`. This document records the endpoint contracts, response
shapes, and the mapping rules used by `anypick.openrouter`.

## Endpoints

| purpose | method | URL | auth |
|---|---|---|---|
| list models | GET | `https://openrouter.ai/api/v1/models` | none |
| list benchmarks | GET | `https://openrouter.ai/api/v1/benchmarks` | `Authorization: Bearer <key>` |

Benchmarks are rate-limited: **30 req/min per key**, **500 req/day per account**.
The models endpoint is free and unauthenticated.

## Models — `GET /api/v1/models`

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
| `task_type` | `coding` \| `intelligence` \| `agentic` \| `search` | narrow by task |
| `benchmark_type` | `gpqa_diamond`, `tau_bench_verified_airline`, `search_browsecomp`, `search_hle`, `search_dsqa`, `search_widesearch` | one exact OpenRouter benchmark |

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

Category-mapped shape. v1 maps the category to `score` via the provider's
published category→score table; `benchmark_type` = the category name. (The
exact table is recorded in `anypick/openrouter.py`.)

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
