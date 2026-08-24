# Provider: Vercel AI Gateway (models only)

The [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) exposes a
OpenAI-shaped model catalog via its REST API. anypick uses it as a **models-only**
provider: there is no benchmark feed, so only price/capability/context filters
and the `cheapest` strategy are meaningful against it.

This document records the endpoint contract, response shape, and the mapping
rules used by `anypick.vercel`.

## Endpoints

| purpose | method | URL | auth |
|---|---|---|---|
| list models | GET | `https://ai-gateway.vercel.sh/v1/models` | none (public); optional `Authorization: Bearer <key>` raises the rate ceiling |
| get model endpoints | GET | `https://ai-gateway.vercel.sh/v1/models/{creator}/{model}/endpoints` | Bearer key |

anypick v1 uses only the list-models endpoint. The single-model endpoints
endpoint (per-provider pricing, capabilities, and supported parameters for each
endpoint serving a model) is available for a future per-model capability fast
path — it is the only place structured-output support can be derived
authoritatively; the list endpoint carries no such signal.

Base URL: `https://ai-gateway.vercel.sh/v1`.

## Models — `GET /v1/models`

Follows the OpenAI models API format. **No authentication required.**

### Query parameters

None. The endpoint returns every model available through the gateway; narrowing
is done client-side by the filter engine.

### Envelope

```json
{ "object": "list", "data": [ … ] }
```

### Item shape (representative)

```json
{
  "id": "google/gemini-3.1-pro-preview",
  "object": "model",
  "created": 1755815280,
  "released": 1763424000,
  "owned_by": "google",
  "name": "Gemini 3.1 Pro Preview",
  "description": "…",
  "context_window": 1000000,
  "max_tokens": 64000,
  "type": "language",
  "tags": ["file-input", "tool-use", "reasoning", "vision"],
  "pricing": {
    "input": "0.000002",
    "output": "0.000012",
    "input_cache_read": "0.0000002",
    "input_cache_write": "0.000002"
  }
}
```

### Response fields

| field | type | meaning |
|---|---|---|
| `id` | string | model identifier, e.g. `"openai/gpt-5.6-sol"`; join key |
| `object` | string | always `"model"` |
| `created` | integer | unix timestamp when added to the gateway |
| `released` | integer | unix timestamp when the model was released |
| `owned_by` | string | provider / owner |
| `name` | string | human-readable name |
| `description` | string | model description |
| `context_window` | integer | maximum context length in tokens |
| `max_tokens` | integer | maximum output tokens |
| `type` | string | `language` \| `embedding` \| `reranking` \| `image` \| `video` |
| `tags` | string[] | capability tags, e.g. `reasoning`, `tool-use`, `vision`, `file-input` |
| `pricing` | object | pricing; structure varies by model type (see below) |
| `pricing.input` | string | USD per input token |
| `pricing.output` | string | USD per output token (language models only) |
| `pricing.input_cache_read` | string | USD per cached input token (read) |
| `pricing.input_cache_write` | string | USD per input token (cache write) |
| `pricing.image` | string | USD per generated image (image models only) |
| `pricing.web_search` | string | USD per web search request |

`pricing` may also carry tiered arrays (`input_tiers`, `output_tiers`); anypick
v1 reads only the base `input` / `output` / `input_cache_read` keys and leaves
the rest in `raw.pricing`.

### Pricing key variety

The `pricing` object's keys are **not uniform** across model types:

* language: `{input, output}` or `+ input_cache_read`, `+ input_cache_write`
* image: `{image}` (and possibly `web_search`)
* embedding / reranking: `{input}` only

**Mapping rule:** `Model` uses only the three well-known keys; everything else
stays in `raw.pricing`.

* `prompt_price` = `float(pricing.get("input", 0))`
* `completion_price` = `float(pricing.get("output", 0))` (absent on image /
  embedding models → `0.0`)
* `cache_read_price` = `float(pricing.get("input_cache_read", 0))`

Free models report `"0"` strings; these parse to `0.0`.

### Capability derivation

The list-models payload exposes no capability parameters array; the only
signal is the `tags` array. anypick derives:

| `Model` flag | derived from |
|---|---|
| `supports_tools` | `"tool-use" in tags` |
| `supports_reasoning` | `"reasoning" in tags` |
| `supports_structured_outputs` | `False` (unknown — no signal on this endpoint; see the endpoints endpoint above) |

### Modality derivation

Vercel does not expose explicit modality arrays, so anypick derives them:

* **input modalities** — language/embedding/reranking/image/video models accept
  `text` by default; tags add the rest:
  `vision` → `image`, `file-input` → `file`, `audio-input` → `audio`.
* **output modalities** — derived from `type`:
  `language` → `["text"]`, `image` → `["image"]`, `video` → `["video"]`;
  `embedding` / `reranking` → `[]` (vectors are not a chat modality).

### Field mapping

| `Model` | source |
|---|---|
| `id` | `id` |
| `name` | `name` |
| `context_length` | `context_window` |
| `input_modalities` | derived from `type` + `tags` (see above) |
| `output_modalities` | derived from `type` (see above) |
| `prompt_price` | `pricing.input` |
| `completion_price` | `pricing.output` |
| `cache_read_price` | `pricing.input_cache_read` |
| `supports_tools` | `"tool-use" in tags` |
| `supports_reasoning` | `"reasoning" in tags` |
| `supports_structured_outputs` | `False` |
| `raw` | the whole item |

## Benchmarks

**None.** The Vercel AI Gateway does not publish a benchmark feed. Wiring the
gateway into `anypick()` pairs `VercelModelObtainer` with
`NoopBenchmarkObtainer` (which always returns `[]`). Consequently only
price-only strategies (`cheapest`) are meaningful; strategies that need scores
(`cheapest_with_floor`, `best_score`, `best_value`) will find no scores and
behave as if every model's score is unknown.

## Rate-limit & error handling

The list-models endpoint is public and unauthenticated; a 429 is unlikely but
still mapped to `RateLimited` (no retries by default, since `max_retries=0`).
A 401 surfaces `BadAuth` immediately; other non-2xx →
`ProviderError(status, body)`. Passing an API key raises the unauthenticated
rate ceiling.

## Caching defaults

| endpoint | default TTL |
|---|---|
| `/v1/models` | 6h |

Cache keys are hashed over (endpoint, sorted query params, api-key fingerprint).
`refresh=True` bypasses the cache for a single call. The default `FileCache`
lives under `~/.cache/anypick`.

## Wiring

```python
from anypick import anypick, ModelFilters

sel = anypick(
    filters=ModelFilters(
        max_prompt_price=2e-6,
        min_context_length=128_000,
        requires_tools=True,
    ),
    strategy="cheapest",
    obtainer="vercel",                 # or pass (VercelModelObtainer(), NoopBenchmarkObtainer())
    vercel_api_key=os.environ.get("VERCEL_AI_GATEWAY_API_KEY"),  # optional
)
print(sel.model.id, sel.prompt_price)
```

Lower level:

```python
from anypick.vercel import VercelModelObtainer
models = VercelModelObtainer(api_key=None).list_models()
```

`VERCEL_AI_GATEWAY_API_KEY` is read when `api_key` is not passed.
