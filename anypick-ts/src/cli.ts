#!/usr/bin/env node
/**
 * Minimal CLI: `anypick --strategy cheapest --max-prompt 2e-6 ...`.
 *
 * Very small — the library is the API; this is a convenience for ad-hoc queries.
 */

import { anypick } from "./api.js";
import { BenchmarkThreshold, ModelFilters } from "./filter.js";

interface CliArgs {
  strategy?: string;
  maxPrompt?: number;
  maxCompletion?: number;
  minContext?: number;
  tools?: boolean;
  structured?: boolean;
  benchmarkSource?: string;
  benchmarkTask?: string;
  benchmarkMin?: number;
  provider?: string;
  apiKey?: string;
  noCache?: boolean;
  refresh?: boolean;
  json?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        console.error(`error: ${a} requires a value`);
        process.exit(2);
      }
      return v;
    };
    switch (a) {
      case "--strategy":
        args.strategy = next();
        break;
      case "--max-prompt":
        args.maxPrompt = Number(next());
        break;
      case "--max-completion":
        args.maxCompletion = Number(next());
        break;
      case "--min-context":
        args.minContext = Number(next());
        break;
      case "--tools":
        args.tools = true;
        break;
      case "--structured":
        args.structured = true;
        break;
      case "--benchmark-source":
        args.benchmarkSource = next();
        break;
      case "--benchmark-task":
        args.benchmarkTask = next();
        break;
      case "--benchmark-min":
        args.benchmarkMin = Number(next());
        break;
      case "--provider":
        args.provider = next();
        break;
      case "--api-key":
        args.apiKey = next();
        break;
      case "--no-cache":
        args.noCache = true;
        break;
      case "--refresh":
        args.refresh = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "-h":
      case "--help": {
        printHelp();
        process.exit(0);
      }
      default:
        console.error(`error: unknown argument ${a}`);
        process.exit(2);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    `anypick — pick an LLM.

Usage: anypick [options]

Options:
  --strategy <s>          cheapest | cheapest_with_floor | best_score | best_value (default: cheapest)
  --max-prompt <usd/tok>   upper bound on prompt price
  --max-completion <usd>   upper bound on completion price
  --min-context <n>       minimum context length
  --tools                 require tool support
  --structured            require structured-output support
  --benchmark-source <s>  narrow benchmarks by source
  --benchmark-task <s>    coding | intelligence | agentic
  --benchmark-min <n>     minimum benchmark score (source-native scale)
  --provider <s>          openrouter | vercel (default: openrouter)
  --api-key <key>         provider API key (defaults from env per --provider)
  --no-cache              disable the on-disk cache
  --refresh               bypass the cache for this call
  --json                  emit the full Selection as JSON
  -h, --help              show this help
`,
  );
}

function buildFilters(args: CliArgs): ModelFilters {
  let bt: BenchmarkThreshold | undefined;
  if (args.benchmarkTask || args.benchmarkSource || args.benchmarkMin !== undefined) {
    bt = new BenchmarkThreshold({
      source: args.benchmarkSource ?? null,
      taskType: args.benchmarkTask ?? null,
      min: args.benchmarkMin ?? null,
    });
  }
  return new ModelFilters({
    maxPromptPrice: args.maxPrompt,
    maxCompletionPrice: args.maxCompletion,
    minContextLength: args.minContext,
    requiresTools: args.tools ?? null,
    requiresStructuredOutputs: args.structured ?? null,
    minBenchmarks: bt ? [bt] : undefined,
  });
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const filters = buildFilters(args);
  const provider = args.provider ?? "openrouter";

  let apiKey = args.apiKey;
  if (apiKey === undefined) {
    apiKey =
      process.env[provider === "openrouter" ? "OPENROUTER_API_KEY" : "VERCEL_AI_GATEWAY_API_KEY"];
  }

  const sel = await anypick({
    filters,
    strategy: (args.strategy as never) ?? "cheapest",
    obtainer: provider,
    openrouterApiKey: provider === "openrouter" ? apiKey : null,
    vercelApiKey: provider === "vercel" ? apiKey : null,
    cache: !args.noCache,
    refresh: args.refresh,
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(sel.toJSON(), null, 2) + "\n");
  } else {
    const m = sel.model;
    const line =
      `${m.id}\t$${sel.promptPrice.toExponential(2)}/tok prompt\t` +
      `$${sel.completionPrice.toExponential(2)}/tok completion\tctx ${m.contextLength}`;
    console.log(line);
    if (sel.score) {
      const tag = sel.score.taskType ?? sel.score.benchmarkType;
      console.log(`  score: ${sel.score.source}/${tag ?? "?"} = ${sel.score.score}`);
    }
    console.log(
      `  candidates considered: ${sel.candidatesConsidered}  strategy: ${sel.strategy}`,
    );
  }
  return 0;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
