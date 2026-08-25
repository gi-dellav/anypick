# anypick

Select the best LLM across providers using filters over capabilities, pricing,
and benchmarks, then pick a winner with a strategy. anypick only selects — you
wire the chosen model into your chat client.

Two implementations share the same design, fixtures, and behavior:

- `anypick-python/`
- `anypick-ts/`

## Example

### Python

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
    openrouter_api_key=os.environ["OPENROUTER_API_KEY"],
)
print(sel.model.id)
```

### TypeScript

```ts
import { anypick, ModelFilters } from "anypick";

const sel = await anypick({
  filters: new ModelFilters({
    maxPromptPrice: 2e-6,
    minContextLength: 128_000,
    requiresTools: true,
  }),
  strategy: "cheapest",
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
});

console.log(sel.model.id);
```

## Providers

anypick v1 ships two model providers; wiring differs by capability:

| provider | source | models | benchmarks | auth | docs |
|---|---|---|---|---|---|
| `openrouter` | OpenRouter API | ✅ `GET /api/v1/models` | ✅ `GET /api/v1/benchmarks` | optional `OPENROUTER_API_KEY` (required for benchmarks, 30 req/min · 500 req/day) | [`docs/providers/openrouter.md`](docs/providers/openrouter.md) |
| `vercel` | Vercel AI Gateway | ✅ `GET /v1/models` | ❌ none (no benchmark feed) | optional `VERCEL_AI_GATEWAY_API_KEY` (raises rate ceiling) | [`docs/providers/vercel.md`](docs/providers/vercel.md) |

`openrouter` (the default) is the only provider with both a model catalog and
benchmarks, so it supports every strategy. `vercel` is **models-only**: pair it
with `NoopBenchmarkObtainer`, and only price-only strategies (`cheapest`) are
meaningful — `cheapest_with_floor`, `best_score`, and `best_value` find no
scores and behave as if every model's score is unknown.

Select a provider with the `obtainer` argument (or pass obtainers directly):

```python
from anypick import anypick, ModelFilters, VercelModelObtainer, NoopBenchmarkObtainer

sel = anypick(
    filters=ModelFilters(requires_tools=True),
    strategy="cheapest",
    obtainer="vercel",   # or (VercelModelObtainer(), NoopBenchmarkObtainer())
)
```

Prefer fine-grained control? Pass a custom model and/or benchmark obtainer
individually with `model_obtainer` / `benchmark_obtainer` — they override the
corresponding side of `obtainer`:

```python
from anypick import anypick, MyModelObtainer, MyBenchmarkObtainer

sel = anypick(
    filters=ModelFilters(requires_tools=True),
    model_obtainer=MyModelObtainer(),      # custom model catalog
    benchmark_obtainer=MyBenchmarkObtainer(),  # custom benchmark feed
)
```

## Filters

Filters reduce `(models, scores)` to a subset before a strategy picks a
winner. Build them ergonomically with `ModelFilters`, or as composable
predicates with `pred.*` — both compile to the same engine.

### `ModelFilters` fields

Everything is optional; `None` means "no constraint on this dimension". Clauses
apply in the order listed (the order reported by `NoModelsFound.survivors_by_clause`).

| category | field | semantics |
|---|---|---|
| ids / makers | `include_ids` | whitelist — keep only ids in the list |
| | `exclude_ids` | blacklist — drop ids in the list |
| | `include_makers` | whitelist — keep only makers in the list |
| | `exclude_makers` | blacklist — drop makers in the list |
| price (USD/token) | `min_prompt_price` | `prompt_price ≥` value |
| | `max_prompt_price` | `prompt_price ≤` value |
| | `min_completion_price` | `completion_price ≥` value |
| | `max_completion_price` | `completion_price ≤` value |
| | `min_expected_cost` | `α·prompt + β·completion ≥` value |
| | `max_expected_cost` | `α·prompt + β·completion ≤` value |
| | `expected_cost_weights` | `(α, β)` for expected-cost bounds & strategies |
| | `max_cache_read_price` | `cache_read_price ≤` value (0.0 if n/a) |
| context | `min_context_length` | `context_length ≥` value |
| | `max_context_length` | `context_length ≤` value |
| modalities | `modalities_in` | inputs ⊇ given set |
| | `modalities_exactly` | inputs == given set |
| | `excludes_modalities` | inputs ∩ given set = ∅ |
| | `output_modalities_in` | outputs ⊇ given set |
| | `output_modalities_exactly` | outputs == given set |
| | `excludes_output_modalities` | outputs ∩ given set = ∅ |
| capabilities (tri-state) | `requires_tools` | `None`=ignore · `True`=must support · `False`=must **not** |
| | `requires_reasoning` | as above |
| | `requires_structured_outputs` | as above |
| benchmarks | `min_benchmarks` | list of `BenchmarkThreshold`; pass **all** (AND) |
| | `max_benchmarks` | list of `BenchmarkThreshold`; pass **all** (AND) |

A **maker** is the `id` prefix before the first `/` (e.g. `"openai"` for
`"openai/gpt-4o"`). Makers without a `/` have no maker: a maker whitelist drops
them, a blacklist leaves them alone. Sigils are preserved verbatim
(OpenRouter's `~deepseek/...` has maker `~deepseek`).

`BenchmarkThreshold` narrows by `source` (`"artificial-analysis"`,
`"openrouter"`, `"design-arena"`), `task_type` (`coding | intelligence |
agentic`), and `benchmark_type` (a specific OpenRouter benchmark field, e.g.
`gpqa_diamond`), with `min`/`max` on the source's native scale.

Benchmark matching: a model passes a threshold iff **at least one** of its
scores matching the threshold's `source`/`task_type`/`benchmark_type`
(wildcards) satisfies the bound. **Unknown ≠ zero** — a threshold with only
`source`/`task_type` and no `min`/`max` keeps scoreless models.

### Predicate form — `pred.*`

For negation, alternation, or custom logic, compose predicates with `&` (and),
`|` (or), and `~` (not); negate a capability to forbid it:

```python
from anypick import pred

f = (pred.maker_in(["openai", "anthropic"])
     & pred.price_below(prompt=2e-6, completion=8e-6)
     & pred.price_above(prompt=1e-7)          # skip free tier
     & pred.context_at_least(128_000)
     & pred.context_at_most(1_000_000)
     & pred.modalities_exactly(["text", "image"])
     & pred.supports_tools()
     & ~pred.supports_reasoning()              # forbid reasoning
     & pred.benchmark_above(task_type="coding", min=60))
```

| predicate | keeps model if |
|---|---|
| `pred.id_in([...])` / `id_not_in([...])` | id is / isn't in the list |
| `pred.maker_in([...])` / `maker_not_in([...])` | maker is / isn't in the list |
| `pred.price_below(*, prompt=None, completion=None)` | each given price ≤ bound |
| `pred.price_above(*, prompt=None, completion=None)` | each given price ≥ bound |
| `pred.expected_cost_below(max, weights=(α,β))` | `α·prompt+β·completion ≤ max` |
| `pred.expected_cost_above(min, weights=(α,β))` | `α·prompt+β·completion ≥ min` |
| `pred.cache_read_price_below(max)` | `cache_read_price ≤ max` |
| `pred.context_at_least(n)` / `context_at_most(n)` | `context_length ≥ / ≤ n` |
| `pred.modalities_in([...])` / `modalities_exactly([...])` / `modalities_not_in([...])` | inputs ⊇ / == / ∩ ∅ |
| `pred.output_modalities_in([...])` / `output_modalities_exactly([...])` / `output_modalities_not_in([...])` | outputs ⊇ / == / ∩ ∅ |
| `pred.supports_tools()` / `supports_reasoning()` / `supports_structured_outputs()` | flag true (use `~` to forbid) |
| `pred.benchmark_above(*, source=None, task_type=None, benchmark_type=None, min=None)` | ≥1 matching score ≥ `min` |
| `pred.benchmark_below(*, ..., max=None)` | ≥1 matching score ≤ `max` |

Apply filters directly with `apply_filters(models, scores, filters)`; `pick_best`
and `anypick` call it internally. See [`docs/filters.md`](docs/filters.md) for
full semantics, and [`docs/strategies.md`](docs/strategies.md) for the pickers
that run on the filtered set.

## More

- [`docs/`](docs/) — full design and API reference
- [`anypick-python/README.md`](anypick-python/README.md)
- [`anypick-ts/README.md`](anypick-ts/README.md)