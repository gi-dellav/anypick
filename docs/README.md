# anypick — documentation

Select an LLM across all providers using filters over capabilities, pricing and
benchmarks, then pick the best survivor via a strategy.

| doc | what's in it |
|---|---|
| [PLAN.md](PLAN.md) | the original design plan |
| [architecture.md](architecture.md) | internal contract: layers, normalized types, join, caching, errors |
| [api-reference.md](api-reference.md) | the public Python API |
| [filters.md](filters.md) | filter DSL — spec form + predicate combinators |
| [strategies.md](strategies.md) | `pick_best` strategies & `Selection` |
| [providers/openrouter.md](providers/openrouter.md) | OpenRouter endpoint contracts & mapping rules |

## 30-second tour

```python
import os
from anypick import anypick, ModelFilters, BenchmarkThreshold

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

print(sel.model.id)          # the pick
print(sel.prompt_price)      # USD/token
print(sel.score.score)       # the coding index that qualified it
print(sel.candidates_considered)
```

`anypick` only **selects**. Wiring the chosen `Model.id` into your chat client
is your job.
