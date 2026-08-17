# Filters

Filters reduce `(models, scores)` to a subset. There are two equivalent ways to
build a filter; both compile to the same `Predicate` engine.

## Spec form — `ModelFilters`

The ergonomic form for the common cases:

```python
from anypick import ModelFilters, BenchmarkThreshold

filters = ModelFilters(
    max_prompt_price=2e-6,
    max_completion_price=8e-6,
    min_context_length=128_000,
    modalities_in=["text"],
    requires_tools=True,
    requires_structured_outputs=True,
    min_benchmark=BenchmarkThreshold(task_type="coding", min=60),
)
```

Every field is optional; `None` means "no constraint on this dimension".

### Fields

| field | semantics |
|---|---|
| `max_prompt_price` | `Model.prompt_price ≤` value |
| `max_completion_price` | `Model.completion_price ≤` value |
| `max_expected_cost` | `α·prompt + β·completion ≤` value (weights below) |
| `expected_cost_weights` | `(α, β)` for `max_expected_cost` and the strategies |
| `min_context_length` | `context_length ≥` value |
| `modalities_in` | model's `input_modalities` ⊇ the given list |
| `output_modalities_in` | model's `output_modalities` ⊇ the given list |
| `requires_tools` | if `True`, `supports_tools` must be true; if `False`, ignored |
| `requires_reasoning` | as above |
| `requires_structured_outputs` | as above |
| `exclude_ids` | drop models whose `id` is in the list |
| `min_benchmark` | keep models with ≥1 matching score ≥ `min` (see below) |
| `max_benchmark` | keep models with ≥1 matching score ≤ `max` |

### `BenchmarkThreshold`

```python
@dataclass
class BenchmarkThreshold:
    source:         str | None = None
    task_type:      str | None = None
    benchmark_type: str | None = None
    min:            float | None = None
    max:            float | None = None
```

* `source` narrows to one feed (`"artificial-analysis"`, `"openrouter"`,
  `"design-arena"`). `None` = any source.
* `task_type` narrows to `"coding" | "intelligence" | "agentic" | "search"`.
* `benchmark_type` narrows to a specific OpenRouter benchmark
  (e.g. `"gpqa_diamond"`, `"search_widesearch"`).
* `min`/`max` are on the **source's native scale**
  (artificial-analysis ~0–100, openrouter 0–1). See
  [`architecture.md`](architecture.md) §"Why `score` is not re-normalized".

## Predicate form — `pred.*`

For cases the spec can't express (negation, alternation, custom logic):

```python
from anypick import pred

f = (pred.price_below(prompt=2e-6, completion=8e-6)
     & pred.context_at_least(128_000)
     & pred.supports_tools()
     & pred.supports_structured_outputs()
     & pred.benchmark_above(task_type="coding", min=60))
```

`pred.*` returns a `Predicate = Callable[[Model, list[BenchmarkScore]], bool]`.
Combinators: `&` (and), `|` (or), `~` (not). A `ModelFilters` compiles to a
`Predicate` internally, so both forms feed the same engine.

### Available predicates

| predicate | keeps model if |
|---|---|
| `pred.price_below(*, prompt=None, completion=None)` | each given price ≤ bound |
| `pred.expected_cost_below(max, weights=(1.0,1.0))` | `α·prompt+β·completion ≤ max` |
| `pred.context_at_least(n)` | `context_length ≥ n` |
| `pred.modalities_in([...])` | inputs ⊇ given set |
| `pred.output_modalities_in([...])` | outputs ⊇ given set |
| `pred.supports_tools()` | `supports_tools` |
| `pred.supports_reasoning()` | `supports_reasoning` |
| `pred.supports_structured_outputs()` | `supports_structured_outputs` |
| `pred.id_not_in([...])` | id not in list |
| `pred.benchmark_above(*, source=None, task_type=None, benchmark_type=None, min=None)` | ≥1 matching score ≥ `min` |
| `pred.benchmark_below(*, ..., max=None)` | ≥1 matching score ≤ `max` |

## Benchmark-aware filters — semantics

A model can carry **multiple** scores (different sources / task types /
benchmark types). Matching works as follows:

1. The engine groups `scores` by `model_id`.
2. For a `min_benchmark` / `max_benchmark` clause (or `pred.benchmark_*`), it
   finds the candidate scores matching **all** of the clause's
   `source`/`task_type`/`benchmark_type` fields (each `None` = wildcard).
3. The model is kept iff **at least one** candidate score satisfies
   `min ≤ score ≤ max`.
4. **Unknown ≠ zero.** A model with *no* matching score is dropped **only if**
   the clause specifies a `min` or `max`. A clause with only `source`/`task_type`
   and no threshold keeps scoreless models (we know they were measured by that
   source/task, we just don't bound them).

This avoids the classic bug where "coding score ≥ 60" silently drops every
model that OpenRouter simply hasn't benchmarked.

## Applying filters

```python
from anypick import apply_filters
candidates = apply_filters(models, scores, filters)   # filters = spec or Predicate
```

`pick_best` and `anypick` call this internally; you only need it if you want the
filtered list without picking.
