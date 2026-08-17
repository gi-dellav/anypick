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
        min_benchmark=BenchmarkThreshold(task_type="coding", min=60),
    ),
    strategy="cheapest_with_floor",
    openrouter_api_key=os.environ["OPENROUTER_API_KEY"],
)
print(sel.model.id, sel.prompt_price, sel.score.score)
```

## Test

```bash
pytest -q
```

Tests run offline against committed fixtures in `tests/fixtures/`.
