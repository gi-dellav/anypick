# anypick — plan

A library to choose an LLM by filtering across capabilities, pricing, and benchmarks, then picking the best via a strategy (e.g. cheapest among the filtered set). Built on two provider-agnostic abstractions: `ModelListObtainer` and `BenchmarkObtainer`. OpenRouter is the first provider for both.

## OpenRouter endpoints

### Models — `GET https://openrouter.ai/api/v1/models` (no auth)
Returns `{data, total_count, links}`. Each model entry has:
- `id`, `canonical_slug`, `hugging_face_id`, `name`, `description`, `created`
- `context_length`
- `architecture.{modality, input_modalities[], output_modalities[], tokenizer, instruct_type}`
- `pricing.{prompt, completion, input_cache_read}` — **strings**, USD/token
- `top_provider.{context_length, max_completion_tokens, is_moderated}`
- `supported_parameters[]`, `default_parameters`, `reasoning.{mandatory, default_enabled, supported_efforts, default_effort}`
- `per_request_limits`, `knowledge_cutoff`, `expiration_date`, `links`

### Benchmarks — `GET https://openrouter.ai/api/v1/benchmarks` (requires `Authorization: Bearer <key>`)
Query params:
- `source` ∈ `artificial-analysis` | `design-arena` | `openrouter`
- `task_type` ∈ `coding` | `intelligence` | `agentic` | `search`
- `benchmark_type` ∈ `gpqa_diamond`, `tau_bench_verified_airline`, `search_browsecomp`, `search_hle`, `search_dsqa`, `search_widesearch`

Rate limited: 30 req/min per key, 500 req/day per account.

Items are **heterogeneous by source**:
- **artificial-analysis**: `{display_name, model_permaslug, intelligence_index, coding_index, agentic_index, pricing:{completion,prompt}, source}`
- **openrouter**: `{display_name, model_permaslug, benchmark_type, accuracy, accuracy_stddev, avg_cost_per_task, total_tasks, last_run_timestamp, source}`
- **design-arena**: category-mapped shape.

`meta`: `{as_of, citation, model_count, source, source_url, task_type, version}`.

Join key: `model_permaslug` (benchmarks) ↔ `id`/`canonical_slug` (models).

## Architecture

```
anypick-python/
  pyproject.toml
  anypick/
    __init__.py        # exports: anypick(), ModelFilters, pred, pick_best, Model, BenchmarkScore
    model.py           # normalized Model + BenchmarkScore dataclasses
    obtainer.py        # ModelListObtainer / BenchmarkObtainer Protocols + Cache + Cached* wrappers
    openrouter.py      # OpenRouterModelObtainer, OpenRouterBenchmarkObtainer
    filter.py          # ModelFilters spec + predicate combinator DSL
    pick.py            # pick_best + strategies
    cli.py             # optional CLI
  tests/
    fixtures/          # snapshots of /models and /benchmarks
```

### Normalized types (provider-agnostic)

```python
@dataclass
class Model:
    id: str
    name: str
    context_length: int
    input_modalities: list[str]
    output_modalities: list[str]
    prompt_price: float
    completion_price: float
    cache_read_price: float
    supports_tools: bool
    supports_reasoning: bool
    supports_structured_outputs: bool
    raw: dict

@dataclass
class BenchmarkScore:
    model_id: str
    source: str
    task_type: str | None
    benchmark_type: str | None
    score: float
    accuracy: float | None
    stddev: float | None
    raw: dict
```

### Obtainer abstractions

```python
class ModelListObtainer(Protocol):
    def list_models(self, **opts) -> list[Model]: ...

class BenchmarkObtainer(Protocol):
    def list_benchmarks(self, *, source=None, task_type=None,
                        benchmark_type=None, **opts) -> list[BenchmarkScore]: ...
```
- Caching/TTL via wrapper `CachedModelObtainer(inner, ttl=…)` so the core obtainer stays pure.

### OpenRouter implementations
- `OpenRouterModelObtainer(base_url, api_key=None)`: GET `/models`, map → `Model`. Pricing strings → floats. `supports_tools = "tools" in supported_parameters`.
- `OpenRouterBenchmarkObtainer(api_key, **)` (key required): GET `/benchmarks` with forwarded query params. Map per source into `BenchmarkScore`; `score` derived:
  - artificial-analysis: index for `task_type` (coding→coding_index, agentic→agentic_index, …), else intelligence_index.
  - openrouter: `score = accuracy`.
  - design-arena: category → score.
- Join `BenchmarkScore.model_id` against `Model.id` (fallback `canonical_slug`); models with no scores are kept.

### Filter DSL
Two flavors:
- **Spec (primary):** `ModelFilters(max_prompt_price=…, min_context_length=…, modalities_in=[…], requires_tools=…, min_benchmark={"source":…,"task_type":"coding","min":60.0})`
- **Combinable predicates (advanced):** `pred.price_below(prompt=…) & pred.context_at_least(…) & pred.supports_tools()`

Benchmark-aware filters (`min_benchmark`, `benchmark_above`) use the joined scores table.

### `pick_best`
```python
def pick_best(models, scores, filters, strategy) -> Selection
```
Strategies:
- `cheapest` — minimize `prompt + completion` (or weighted `α*prompt + β*completion`).
- `cheapest_with_floor` — cheapest among models with benchmark ≥ threshold.
- `best_score` — maximize benchmark score for given source/task_type; tie-break price.
- `best_value` — maximize `score / expected_cost`.

Raise `NoModelsFound` on empty filtered set. Return a `Selection(model, score, price, rationale)`.

### High-level convenience
```python
sel = anypick(
    filters=ModelFilters(max_prompt_price=1e-6, min_benchmark={"task_type":"coding","min":60}),
    strategy="cheapest",
    obtainer="openrouter",
    openrouter_api_key=os.environ["OPENROUTER_API_KEY"],
)
```

### Caching & rate-limits
- Models: free/public → cache 6h.
- Benchmarks: 30/min, 500/day → cache 24h, backoff on 429.
- `Cache` protocol (`get`/`set`), default `FileCache` under `~/.cache/anypick`.

### Testing
- Fixtures: committed snapshots of both endpoints → offline tests.
- Cases: obtainer parsing of heterogeneous benchmark shapes; filter composition; each strategy; join correctness (with/without scores); cache TTL; error mapping (401/429/5xx).

### Out of scope (v1)
- Other providers (Mintlify, Together, artificialanalysis.ai direct) — architecture leaves room.
- Calling/chatting the chosen model — selection only.

## Open questions
1. Language first: recommend Python.
2. Auth: read `OPENROUTER_API_KEY` env var by default, explicit override optional?
3. Return: `Selection` struct (model + matched score + price + rationale) vs bare `Model`? → lean `Selection`.
4. Score normalization: keep per-source units (artificial-analysis ~0–100, openrouter 0–1) with per-source thresholds, vs normalize all to 0–1? → lean keep-as-is.
