# anypick-python

Python implementation of `anypick`. See the project [docs](../docs) for the
full design.

## Install (dev)

```bash
cd anypick-python
pip install -e ".[dev]"
```

## Use

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
print(sel.model.id, sel.prompt_price, sel.score.score)
```

## Use — Vercel AI Gateway (models only)

The Vercel AI Gateway exposes a model catalog but no benchmark feed, so pair it
with a price-only strategy (`cheapest`):

```python
import os
from anypick import anypick, ModelFilters

sel = anypick(
    filters=ModelFilters(
        max_prompt_price=2e-6,
        min_context_length=128_000,
        requires_tools=True,
    ),
    strategy="cheapest",
    obtainer="vercel",
    vercel_api_key=os.environ.get("VERCEL_AI_GATEWAY_API_KEY"),  # optional
)
print(sel.model.id, sel.prompt_price)
```

## Test

```bash
pytest -q
```

Tests run offline against committed fixtures in `tests/fixtures/`.
