# anypick-ts

<p>
  <a href="https://www.npmjs.com/package/anypick-ts"><img src="https://img.shields.io/npm/v/anypick-ts" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/anypick-ts"><img src="https://img.shields.io/npm/dm/anypick-ts" alt="npm downloads"></a>
</p>

Select an LLM across providers using filters over **capabilities**, **pricing**
and **benchmarks**, then pick the best survivor via a strategy. A TypeScript
port of [`anypick`](../anypick-python) (same design, same fixtures, same
behavior). `anypick` only **selects** — wiring the chosen `Model.id` into your
chat client is your job.

## Install

```bash
npm install anypick-ts          # https://www.npmjs.com/package/anypick-ts
# or from source:
npm install && npm run build
```

Requires Node.js ≥ 18 (uses the global `fetch`).

## 30-second tour

```ts
import { anypick, ModelFilters, BenchmarkThreshold } from "anypick-ts";

const sel = await anypick({
  filters: new ModelFilters({
    maxPromptPrice: 2e-6,
    minContextLength: 128_000,
    requiresTools: true,
    minBenchmarks: [new BenchmarkThreshold({ taskType: "coding", min: 60 })],
  }),
  strategy: "cheapest_with_floor",
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
});

console.log(sel.model.id);          // the pick
console.log(sel.promptPrice);       // USD/token
console.log(sel.score?.score);      // the coding index that qualified it
console.log(sel.candidatesConsidered);
```

## API surface

```ts
// one-shot (async — fetches models + benchmarks, joins, filters, picks)
await anypick({ filters, strategy, obtainer, openrouterApiKey, cache, refresh });

// pure (sync — operates on already-fetched data)
pickBest(models, scores, filters, strategy);
applyFilters(models, scores, filters);

// filter specs
new ModelFilters({ maxPromptPrice, minContextLength, requiresTools, minBenchmarks, ... });
new BenchmarkThreshold({ source, taskType, benchmarkType, min, max });

// predicate combinators (method-based: .and / .or / .not)
pred.priceBelow({ prompt: 1e-6 })
    .and(pred.contextAtLeast(128_000))
    .and(pred.supportsTools())
    .and(pred.benchmarkAbove({ taskType: "coding", min: 60 }));

// normalized types
Model, BenchmarkScore, groupScoresByModel(scores);

// obtainers / extension points
interface ModelListObtainer { listModels(opts?): Promise<Model[]> }
interface BenchmarkObtainer  { listBenchmarks(opts?): Promise<BenchmarkScore[]> }
OpenRouterModelObtainer, OpenRouterBenchmarkObtainer  // first provider
VercelModelObtainer                                    // models-only (AI Gateway)
NoopBenchmarkObtainer                                  // returns []
CachedModelObtainer, CachedBenchmarkObtainer           // TTL wrappers
FileCache (~/.cache/anypick), MemoryCache, Cache

// the result
Selection { model, score, promptPrice, completionPrice, expectedCost,
            candidatesConsidered, strategy, filtersApplied }

// errors
NoModelsFound (carries survivorsByClause), BadAuth, RateLimited, ProviderError
```

## Differences from the Python port

- Async by default: obtainer methods and `anypick()` return `Promises` (they
  use the global `fetch`). `pickBest` / `applyFilters` stay pure & sync.
- camelCase public API (`promptPrice`, `contextLength`, `requiresTools`,
  `maxPromptPrice`, …). `ModelFilters.serialize()` still emits snake_case
  keys so `Selection.filtersApplied` is cross-compatible with the Python
  reference.
- Tri-state capability flags use `boolean | null` (`null`/`undefined` = ignore,
  `true` = require, `false` = forbid).
- Predicate combinators use `.and()` / `.or()` / `.not()` methods (JavaScript
  does not overload `&`/`|`/`~`).
- `expectedCostWeights` is a tuple `[number, number]`.
- The fetch implementation is swappable from tests via
  `setFetchImpl(fn)` from `src/http.ts`.

## CLI

```bash
node dist/cli.js --provider openrouter --strategy cheapest \
  --max-prompt 2e-6 --min-context 128000 --tools \
  --benchmark-task coding --benchmark-min 60
```

Run `node dist/cli.js --help` for the full flag set. Use `--json` to emit the
full `Selection` as JSON.

## Providers

- **OpenRouter** — models (`/api/v1/models`, public) + benchmarks
  (`/api/v1/benchmarks`, key required, 30/min·500/day).
- **Vercel AI Gateway** — models only (`/v1/models`, public; key optional and
  raises the rate ceiling). No benchmark feed; pair with `cheapest`.

See [`../docs`](../docs) for the full design, endpoint contracts, and the
filter/strategy semantics.

## Testing

```bash
npm test        # vitest run
```

The tests reuse the Python fixtures (`tests/fixtures/*.json`) and mirror the
Python test suite — parsing, filters, strategies, join correctness, cache TTL,
and error mapping.
