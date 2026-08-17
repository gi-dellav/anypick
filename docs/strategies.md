# Strategies & `pick_best`

`pick_best` runs a strategy over a filtered set and returns a `Selection`.

```python
pick_best(
    models: list[Model],
    scores: list[BenchmarkScore],
    filters: ModelFilters | Predicate | None = None,
    strategy: Strategy = "cheapest",
) -> Selection
```

## Steps

1. **Filter** — `apply_filters(models, scores, filters)` → `candidates`.
   If empty → raise `NoModelsFound` with per-clause surviving counts.
2. **Score each candidate** — for strategies that need benchmarks, look up the
   candidate's scores matching the `min_benchmark` clause's
   `source`/`task_type`/`benchmark_type` (wildcards allowed). Pick the
   **best** matching score per model (max for `best_score`/`best_value`; the
   floor-passing score for `cheapest_with_floor`).
3. **Rank** — apply the strategy's key function.
4. **Tie-break** — by `Model.id` ascending, for determinism.

## Strategies

| strategy | key (per candidate) | pick | needs `min_benchmark`? |
|---|---|---|---|
| `cheapest` | `expected_cost = α·prompt + β·completion` | min | no |
| `cheapest_with_floor` | `expected_cost`, restricted to models with a score ≥ `min_benchmark.min` | min | **yes** |
| `best_score` | `-score` (then `expected_cost`) | min | **yes** |
| `best_value` | `expected_cost / score` | min | **yes** |

`expected_cost` uses `ModelFilters.expected_cost_weights` `(α, β)`; default
`(1.0, 1.0)` so `expected_cost = prompt + completion`.

## `Selection`

```python
@dataclass
class Selection:
    model: Model
    score: BenchmarkScore | None       # the score that drove the pick (if any)
    prompt_price: float
    completion_price: float
    expected_cost: float
    candidates_considered: int
    strategy: str
    filters_applied: dict              # serialized spec, for reproducibility
```

`score` is `None` for `cheapest` without benchmarks; otherwise it is the
specific `BenchmarkScore` that drove the pick.

## `NoModelsFound`

Carries diagnostic counts so callers can tell which clause was the killer:

```python
try:
    pick_best(models, scores, filters, "cheapest_with_floor")
except NoModelsFound as e:
    print(e.survivors_by_clause)   # {"max_prompt_price": 80, "requires_tools": 64, "min_benchmark": 12}
```

`survivors_by_clause` is an ordered dict: clause name → count surviving *that*
clause (cumulative, in application order). The last entry being `0` pinpoints
the filter that emptied the set.
