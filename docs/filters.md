# Filters

Filters reduce `(models, scores)` to a subset. There are two equivalent ways to
build a filter; both compile to the same `Predicate` engine.

## Spec form — `ModelFilters`

The ergonomic form for the common cases:

```python
from anypick import ModelFilters, BenchmarkThreshold

filters = ModelFilters(
    include_makers=["openai", "anthropic", "google"],
    exclude_ids=["openai/gpt-4o-mini"],
    min_prompt_price=1e-7,
    max_prompt_price=2e-6,
    max_completion_price=8e-6,
    max_cache_read_price=5e-7,
    min_context_length=128_000,
    max_context_length=1_000_000,
    modalities_exactly=["text", "image"],
    excludes_output_modalities=["audio"],
    requires_tools=True,
    requires_reasoning=False,          # forbid reasoning models
    min_benchmarks=[
        BenchmarkThreshold(task_type="coding", min=60),
        BenchmarkThreshold(task_type="intelligence", min=70),
    ],
)
```

Every field is optional; `None` means "no constraint on this dimension".

### Fields

Fields are listed in the order clauses are applied (the same order reported by
`NoModelsFound.survivors_by_clause`).

#### ids / makers

| field | semantics |
|---|---|
| `include_ids` | whitelist — keep only models whose `id` is in the list |
| `exclude_ids` | blacklist — drop models whose `id` is in the list |
| `include_makers` | whitelist — keep only models whose **maker** is in the list |
| `exclude_makers` | blacklist — drop models whose **maker** is in the list |

The **maker** is the `id` prefix before the first `/` (e.g. `"openai"` for
`"openai/gpt-4o"`). Ids without a `/` have no maker: a maker *whitelist* drops
them, a maker *blacklist* leaves them alone. Any leading sigil is preserved
verbatim (OpenRouter's `~deepseek/...` variant has maker `~deepseek`).

#### price (USD/token)

| field | semantics |
|---|---|
| `min_prompt_price` | `Model.prompt_price ≥` value |
| `max_prompt_price` | `Model.prompt_price ≤` value |
| `min_completion_price` | `Model.completion_price ≥` value |
| `max_completion_price` | `Model.completion_price ≤` value |
| `min_expected_cost` | `α·prompt + β·completion ≥` value (weights below) |
| `max_expected_cost` | `α·prompt + β·completion ≤` value (weights below) |
| `expected_cost_weights` | `(α, β)` for the expected-cost bounds and the strategies |
| `max_cache_read_price` | `Model.cache_read_price ≤` value (0.0 if n/a) |

Price floors (`min_*`) are handy for excluding suspiciously cheap / free tiers
as a quality proxy, or for staying off meta-router sentinels.

#### context

| field | semantics |
|---|---|
| `min_context_length` | `context_length ≥` value |
| `max_context_length` | `context_length ≤` value |

`max_context_length` lets you skip oversized (often pricier) windows you don't
need, or pin a target window.

#### modalities

| field | semantics |
|---|---|
| `modalities_in` | model's `input_modalities` ⊇ the given set |
| `modalities_exactly` | model's `input_modalities` == the given set |
| `excludes_modalities` | model's `input_modalities` ∩ the given set = ∅ |
| `output_modalities_in` | as above, for `output_modalities` |
| `output_modalities_exactly` | as above, for `output_modalities` |
| `excludes_output_modalities` | as above, for `output_modalities` |

`modalities_in` is a *superset* test ("must accept at least these").
`modalities_exactly` pins the set ("text-only in, nothing else").
`excludes_modalities` is a *disjoint* test ("must not accept image/audio").

#### capabilities (tri-state)

| field | semantics |
|---|---|
| `requires_tools` | `None`=ignore · `True`=must support · `False`=must **not** support |
| `requires_reasoning` | as above |
| `requires_structured_outputs` | as above |

`None` (the default) leaves the dimension unconstrained. `True` requires the
capability; `False` **forbids** it — so `requires_tools=False` keeps only models
that *lack* tool support, which the predicate form expresses as
`~pred.supports_tools()`.

#### benchmarks

| field | semantics |
|---|---|
| `min_benchmarks` | list of `BenchmarkThreshold`; a model must pass **all** (AND) |
| `max_benchmarks` | list of `BenchmarkThreshold`; a model must pass **all** (AND) |

Each list is a logical AND of its thresholds, so "coding ≥ 60 **and**
intelligence ≥ 70" is two entries in `min_benchmarks`. `min_benchmarks` and
`max_benchmarks` are independent (both applied). The strategies rank on the
*first* `min_benchmarks` threshold (the primary quality criterion); the rest
still filter but do not drive ranking.

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
* `task_type` narrows to `"coding" | "intelligence" | "agentic"`.
* `benchmark_type` narrows **client-side** to a specific OpenRouter benchmark
  response field (e.g. `"gpqa_diamond"`, `"tau_bench_verified_airline"`). It is
  *not* a server query parameter on `/api/v1/benchmarks`.
* `min`/`max` are on the **source's native scale**
  (artificial-analysis ~0–100, openrouter 0–1). See
  [`architecture.md`](architecture.md) §"Why `score` is not re-normalized".

## Predicate form — `pred.*`

For cases the spec can't express (negation, alternation, custom logic):

```python
from anypick import pred

f = (pred.maker_in(["openai", "anthropic"])
     & pred.price_below(prompt=2e-6, completion=8e-6)
     & pred.price_above(prompt=1e-7)            # skip free tier
     & pred.context_at_least(128_000)
     & pred.context_at_most(1_000_000)
     & pred.modalities_exactly(["text", "image"])
     & pred.supports_tools()
     & ~pred.supports_reasoning()               # forbid reasoning
     & pred.benchmark_above(task_type="coding", min=60))
```

`pred.*` returns a `Predicate = Callable[[Model, list[BenchmarkScore]], bool]`.
Combinators: `&` (and), `|` (or), `~` (not). A `ModelFilters` compiles to a
`Predicate` internally, so both forms feed the same engine.

### Available predicates

| predicate | keeps model if |
|---|---|
| `pred.id_in([...])` | id is in the whitelist |
| `pred.id_not_in([...])` | id is not in the blacklist |
| `pred.maker_in([...])` | maker is in the whitelist |
| `pred.maker_not_in([...])` | maker is not in the blacklist |
| `pred.price_below(*, prompt=None, completion=None)` | each given price ≤ bound |
| `pred.price_above(*, prompt=None, completion=None)` | each given price ≥ bound |
| `pred.expected_cost_below(max, weights=(α,β))` | `α·prompt+β·completion ≤ max` |
| `pred.expected_cost_above(min, weights=(α,β))` | `α·prompt+β·completion ≥ min` |
| `pred.cache_read_price_below(max)` | `cache_read_price ≤ max` |
| `pred.context_at_least(n)` | `context_length ≥ n` |
| `pred.context_at_most(n)` | `context_length ≤ n` |
| `pred.modalities_in([...])` | inputs ⊇ given set |
| `pred.modalities_exactly([...])` | inputs == given set |
| `pred.modalities_not_in([...])` | inputs ∩ given set = ∅ |
| `pred.output_modalities_in([...])` | outputs ⊇ given set |
| `pred.output_modalities_exactly([...])` | outputs == given set |
| `pred.output_modalities_not_in([...])` | outputs ∩ given set = ∅ |
| `pred.supports_tools()` / `supports_reasoning()` / `supports_structured_outputs()` | flag true (use `~` to forbid) |
| `pred.benchmark_above(*, source=None, task_type=None, benchmark_type=None, min=None)` | ≥1 matching score ≥ `min` |
| `pred.benchmark_below(*, ..., max=None)` | ≥1 matching score ≤ `max` |

To forbid a capability in predicate form, negate the positive predicate:
`~pred.supports_tools()`. To AND several benchmark thresholds, just `&` them:
`pred.benchmark_above(task_type="coding", min=60) & pred.benchmark_above(task_type="intelligence", min=70)`.

## Benchmark-aware filters — semantics

A model can carry **multiple** scores (different sources / task types /
benchmark types). Matching works as follows:

1. The engine groups `scores` by `model_id`.
2. For each `min_benchmarks` / `max_benchmarks` threshold (or `pred.benchmark_*`),
   it finds the candidate scores matching **all** of the threshold's
   `source`/`task_type`/`benchmark_type` fields (each `None` = wildcard).
3. The model passes that threshold iff **at least one** candidate score
   satisfies `min ≤ score ≤ max`.
4. The model survives `min_benchmarks` / `max_benchmarks` iff it passes
   **every** threshold in the list.
5. **Unknown ≠ zero.** A model with *no* matching score is dropped **only if**
   the threshold specifies a `min` or `max`. A clause with only `source`/`task_type`
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

## Diagnostics

When a filter empties the set, `NoModelsFound.survivors_by_clause` reports how
many models survived *each* clause, cumulatively, in application order —
including one entry per benchmark threshold (`min_benchmarks[0]`,
`min_benchmarks[1]`, …):

```python
try:
    pick_best(models, scores, filters, "cheapest_with_floor")
except NoModelsFound as e:
    print(e.survivors_by_clause)
    # {"include_makers": 163, "max_prompt_price": 80, "requires_tools": 64,
    #  "min_benchmarks[0]": 12, "min_benchmarks[1]": 0}
```

The last entry being `0` pinpoints the killer clause.
