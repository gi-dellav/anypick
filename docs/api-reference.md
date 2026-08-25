# API reference

`anypick` selects an LLM by filtering across capabilities, pricing and
benchmarks, then picking the best survivor via a strategy. It does not call the
chosen model.

All examples assume:

```python
import os
from anypick import anypick, ModelFilters, BenchmarkThreshold
```

## One-shot entry

### `anypick(...)`

```python
anypick(
    *,
    filters: ModelFilters | Predicate | None = None,
    strategy: Strategy = "cheapest",
    obtainer: str | tuple = "openrouter",
    model_obtainer: ModelListObtainer | None = None,
    benchmark_obtainer: BenchmarkObtainer | None = None,
    openrouter_api_key: str | None = None,
    vercel_api_key: str | None = None,
    cache: Cache | bool = True,
    refresh: bool = False,
) -> Selection
```

Wires obtainers + cache, fetches models and benchmarks, joins, filters, picks.

Arguments:

| arg | default | meaning |
|---|---|---|
| `filters` | `None` | spec or predicate; `None` = no filtering |
| `strategy` | `"cheapest"` | one of `Strategy` |
| `obtainer` | `"openrouter"` | provider id (`"openrouter"` or `"vercel"`), or a `(ModelListObtainer, BenchmarkObtainer)` pair |
| `model_obtainer` | `None` | a custom `ModelListObtainer`; overrides the model side of `obtainer` |
| `benchmark_obtainer` | `None` | a custom `BenchmarkObtainer`; overrides the benchmark side of `obtainer` |
| `openrouter_api_key` | `None` | falls back to `OPENROUTER_API_KEY` env var (benchmarks only) |
| `vercel_api_key` | `None` | falls back to `VERCEL_AI_GATEWAY_API_KEY` env var (optional; the gateway's models endpoint is public) |
| `cache` | `True` | `True` → default `FileCache`; `False` → no cache; or a `Cache` instance |
| `refresh` | `False` | bypass cache for this call |

Returns a [`Selection`](#selection). Raises `NoModelsFound` if the filtered set
is empty, `BadAuth`/`RateLimited`/`ProviderError` on provider failures.

Example:

```python
sel = anypick(
    filters=ModelFilters(
        max_prompt_price=2e-6,
        min_context_length=128_000,
        requires_tools=True,
        min_benchmarks=[BenchmarkThreshold(task_type="coding", min=60)],
    ),
    strategy="cheapest_with_floor",
    openrouter_api_key=os.environ["OPENROUTER_API_KEY"],
)
print(sel.model.id, sel.prompt_price, sel.score.score)
```

## Lower-level entry

### `pick_best(...)`

```python
pick_best(
    models: list[Model],
    scores: list[BenchmarkScore],
    filters: ModelFilters | Predicate | None = None,
    strategy: Strategy = "cheapest",
) -> Selection
```

Pure: no I/O. Use this when you already have the data (e.g. from your own
obtainer or a cached file). Raises `NoModelsFound` if filters empty the set.

## Filters

### `ModelFilters` (spec form)

```python
@dataclass
class ModelFilters:
    # ids / makers
    include_ids:                 list[str] | None = None
    exclude_ids:                 list[str] | None = None
    include_makers:              list[str] | None = None     # maker = id prefix before '/'
    exclude_makers:              list[str] | None = None
    # price (USD/token)
    min_prompt_price:            float | None = None
    max_prompt_price:            float | None = None
    min_completion_price:        float | None = None
    max_completion_price:        float | None = None
    min_expected_cost:           float | None = None         # α·prompt + β·completion
    max_expected_cost:           float | None = None
    expected_cost_weights:       tuple[float, float] = (1.0, 1.0)  # (α, β)
    max_cache_read_price:        float | None = None
    # context
    min_context_length:          int | None = None
    max_context_length:          int | None = None
    # modalities (input)
    modalities_in:               list[str] | None = None     # inputs ⊇ these
    modalities_exactly:          list[str] | None = None     # inputs == these
    excludes_modalities:         list[str] | None = None     # inputs ∩ these = ∅
    # modalities (output)
    output_modalities_in:        list[str] | None = None
    output_modalities_exactly:   list[str] | None = None
    excludes_output_modalities:  list[str] | None = None
    # capabilities (tri-state: None=ignore, True=require, False=forbid)
    requires_tools:              bool | None = None
    requires_reasoning:          bool | None = None
    requires_structured_outputs: bool | None = None
    # benchmarks (each list is a logical AND)
    min_benchmarks:              list[BenchmarkThreshold] | None = None
    max_benchmarks:              list[BenchmarkThreshold] | None = None
```

Capability flags are **tri-state**: `None` ignores the dimension, `True`
requires it, `False` forbids it. `min_benchmarks` / `max_benchmarks` are lists
(a model must satisfy *every* threshold); the strategies rank on the first
`min_benchmarks` threshold. See [`filters.md`](filters.md) for the full
semantics, including the **maker** derivation and the benchmark unknown-≠-zero
rule.

### `BenchmarkThreshold`

```python
@dataclass
class BenchmarkThreshold:
    source:         str | None = None      # default: any source
    task_type:      str | None = None      # "coding" | "intelligence" | "agentic"
    benchmark_type: str | None = None      # response field, e.g. "gpqa_diamond"
    min:            float | None = None    # source-specific scale
    max:            float | None = None
```

### Predicate combinators (advanced)

```python
from anypick import pred
f = (pred.price_below(prompt=1e-6)
     & pred.context_at_least(128_000)
     & pred.supports_tools()
     & pred.benchmark_above(task_type="coding", min=60))
```

`pred.*` returns a `Predicate = Callable[[Model, list[BenchmarkScore]], bool]`.
Combinators: `&` (and), `|` (or), `~` (not). A `ModelFilters` compiles to a
`Predicate` internally, so both forms feed the same engine.

Available predicates (see [`filters.md`](filters.md) for the full table):

| predicate | keeps model if |
|---|---|
| `pred.id_in([...])` / `pred.id_not_in([...])` | id in / not in list |
| `pred.maker_in([...])` / `pred.maker_not_in([...])` | maker in / not in list |
| `pred.price_below(*, prompt=None, completion=None)` | each given price ≤ bound |
| `pred.price_above(*, prompt=None, completion=None)` | each given price ≥ bound |
| `pred.expected_cost_below(max, weights=(α,β))` | `α·prompt+β·completion ≤ max` |
| `pred.expected_cost_above(min, weights=(α,β))` | `α·prompt+β·completion ≥ min` |
| `pred.cache_read_price_below(max)` | `cache_read_price ≤ max` |
| `pred.context_at_least(n)` / `pred.context_at_most(n)` | `context_length` ≥ / ≤ `n` |
| `pred.modalities_in([...])` / `pred.modalities_exactly([...])` / `pred.modalities_not_in([...])` | inputs ⊇ / == / ∅ given set |
| `pred.output_modalities_in` / `_exactly` / `_not_in` | as above, for outputs |
| `pred.supports_tools()` / `supports_reasoning()` / `supports_structured_outputs()` | flag true (use `~` to forbid) |
| `pred.benchmark_above(*, source=None, task_type=None, benchmark_type=None, min=None)` | some matching score ≥ `min` |
| `pred.benchmark_below(*, ..., max=None)` | some matching score ≤ `max` |

## Strategies

`Strategy = Literal["cheapest", "cheapest_with_floor", "best_score", "best_value"]`

| strategy | objective | needs scores? |
|---|---|---|
| `cheapest` | minimize `prompt + completion` (or `expected_cost` if weights set) | no |
| `cheapest_with_floor` | minimize price among models satisfying the first `min_benchmarks` threshold | yes |
| `best_score` | maximize `score` for the first `min_benchmarks` threshold's `source`/`task_type`; tie-break by price | yes |
| `best_value` | maximize `score / expected_cost` | yes |

For `cheapest_with_floor`, `best_score`, `best_value` the strategy reads the
first `min_benchmarks` threshold of `ModelFilters` (or an equivalent
`pred.benchmark_*` predicate) to know *which* score to rank on; the remaining
thresholds still act as filters but do not drive ranking.

## `Selection`

```python
@dataclass
class Selection:
    model: Model
    score: BenchmarkScore | None        # the score that drove the pick, if any
    prompt_price: float
    completion_price: float
    expected_cost: float
    candidates_considered: int
    strategy: str
    filters_applied: dict               # serialized spec, for reproducibility
```

## Obtainers (extension point)

```python
class ModelListObtainer(Protocol):
    def list_models(self, **opts) -> list[Model]: ...

class BenchmarkObtainer(Protocol):
    def list_benchmarks(self, *, source=None, task_type=None,
                        benchmark_type=None, **opts) -> list[BenchmarkScore]: ...
```

Built-in implementations:

* `OpenRouterModelObtainer(base_url=..., api_key=None)`
* `OpenRouterBenchmarkObtainer(api_key, base_url=...)` — key required.
* `VercelModelObtainer(base_url=..., api_key=None)` — models-only; the gateway
  has no benchmark feed, so pair it with `NoopBenchmarkObtainer()` (or use
  `obtainer="vercel"`, which wires that pair for you). See
  [`providers/vercel.md`](providers/vercel.md).
* `NoopBenchmarkObtainer` — returns `[]`; for providers that expose no
  benchmark feed.

Caching wrappers:

* `CachedModelObtainer(inner, cache, ttl=6*3600)`
* `CachedBenchmarkObtainer(inner, cache, ttl=24*3600)`

Caches:

* `Cache` (Protocol), `FileCache(dir="~/.cache/anypick")`, `MemoryCache`.

## Errors

| error | when |
|---|---|
| `NoModelsFound` | filtered set empty (carries per-clause counts) |
| `BadAuth` | 401 from a keyed endpoint |
| `RateLimited` | 429 after backoff exhausted |
| `ProviderError` | other non-2xx (carries status + body) |

See [`architecture.md`](architecture.md) for the internal contract,
[`providers/openrouter.md`](providers/openrouter.md) for OpenRouter specifics,
and [`providers/vercel.md`](providers/vercel.md) for the Vercel AI Gateway.
