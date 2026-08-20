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
    openrouter_api_key: str | None = None,
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
| `obtainer` | `"openrouter"` | provider id, or a `(ModelListObtainer, BenchmarkObtainer)` pair |
| `openrouter_api_key` | `None` | falls back to `OPENROUTER_API_KEY` env var (benchmarks only) |
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
        min_benchmark=BenchmarkThreshold(task_type="coding", min=60),
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
    max_prompt_price:             float | None = None
    max_completion_price:         float | None = None
    max_expected_cost:            float | None = None   # α·prompt + β·completion
    expected_cost_weights:        tuple[float, float] = (1.0, 1.0)  # (α, β)
    min_context_length:           int | None = None
    modalities_in:                list[str] | None = None     # model inputs ⊇ these
    output_modalities_in:         list[str] | None = None
    requires_tools:               bool | None = None
    requires_reasoning:           bool | None = None
    requires_structured_outputs:  bool | None = None
    exclude_ids:                  list[str] | None = None
    min_benchmark:                BenchmarkThreshold | None = None
    max_benchmark:                BenchmarkThreshold | None = None
```

A `ModelFilters` object is a pure spec — no I/O. Apply it with
`apply_filters(models, scores, filters) -> list[Model]`.

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

Available predicates:

| predicate | keeps model if |
|---|---|
| `pred.price_below(*, prompt=None, completion=None)` | each given price ≤ bound |
| `pred.expected_cost_below(max, weights=(α,β))` | `α·prompt+β·completion ≤ max` |
| `pred.context_at_least(n)` | `context_length ≥ n` |
| `pred.modalities_in([...])` | inputs ⊇ given set |
| `pred.output_modalities_in([...])` | outputs ⊇ given set |
| `pred.supports_tools()` / `supports_reasoning()` / `supports_structured_outputs()` | flag true |
| `pred.id_not_in([...])` | id not in list |
| `pred.benchmark_above(*, source=None, task_type=None, benchmark_type=None, min=None)` | some matching score ≥ `min` |
| `pred.benchmark_below(*, ..., max=None)` | some matching score ≤ `max` |

## Strategies

`Strategy = Literal["cheapest", "cheapest_with_floor", "best_score", "best_value"]`

| strategy | objective | needs scores? |
|---|---|---|
| `cheapest` | minimize `prompt + completion` (or `expected_cost` if weights set) | no |
| `cheapest_with_floor` | minimize price among models satisfying `min_benchmark` | yes |
| `best_score` | maximize `score` for the `source`/`task_type` in `min_benchmark`; tie-break by price | yes |
| `best_value` | maximize `score / expected_cost` | yes |

For `cheapest_with_floor`, `best_score`, `best_value` the strategy reads the
`min_benchmark` clause of `ModelFilters` (or an equivalent `pred.benchmark_*`
predicate) to know *which* score to rank on.

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

See [`architecture.md`](architecture.md) for the internal contract and
[`providers/openrouter.md`](providers/openrouter.md) for OpenRouter specifics.
