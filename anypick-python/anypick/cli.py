"""Minimal CLI: ``anypick 'cheapest under $X with coding>=60'``.

Very small — the library is the API; this is a convenience for ad-hoc queries.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from . import (
    BenchmarkThreshold,
    ModelFilters,
    anypick,
    pick_best,
)


def _build_filters(args: argparse.Namespace) -> ModelFilters:
    bt = None
    if args.benchmark_task or args.benchmark_min is not None or args.benchmark_source:
        bt = BenchmarkThreshold(
            source=args.benchmark_source,
            task_type=args.benchmark_task,
            min=args.benchmark_min,
        )
    return ModelFilters(
        max_prompt_price=args.max_prompt,
        max_completion_price=args.max_completion,
        min_context_length=args.min_context,
        requires_tools=args.tools,
        requires_structured_outputs=args.structured,
        min_benchmarks=[bt] if bt else None,
    )


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="anypick", description="Pick an LLM.")
    p.add_argument("--strategy", default="cheapest",
                   choices=["cheapest", "cheapest_with_floor", "best_score", "best_value"])
    p.add_argument("--max-prompt", type=float, dest="max_prompt", default=None)
    p.add_argument("--max-completion", type=float, dest="max_completion", default=None)
    p.add_argument("--min-context", type=int, dest="min_context", default=None)
    p.add_argument("--tools", action="store_const", const=True, default=None,
                   help="require tool support (default: ignore)")
    p.add_argument("--structured", action="store_const", const=True, default=None,
                   help="require structured-output support (default: ignore)")
    p.add_argument("--benchmark-source", default=None)
    p.add_argument("--benchmark-task", default=None,
                   choices=["coding", "intelligence", "agentic"])
    p.add_argument("--benchmark-min", type=float, default=None)
    p.add_argument("--provider", default="openrouter",
                   choices=["openrouter", "vercel"],
                   help="model catalog provider (default: openrouter)")
    p.add_argument("--api-key", default=None,
                   help="provider API key; defaults to OPENROUTER_API_KEY "
                        "or VERCEL_AI_GATEWAY_API_KEY per --provider")
    p.add_argument("--no-cache", action="store_true")
    p.add_argument("--refresh", action="store_true")
    p.add_argument("--json", action="store_true", help="emit full Selection as JSON")
    args = p.parse_args(argv)

    filters = _build_filters(args)
    api_key = args.api_key
    if api_key is None:
        api_key = os.environ.get(
            "OPENROUTER_API_KEY" if args.provider == "openrouter"
            else "VERCEL_AI_GATEWAY_API_KEY"
        )
    sel = anypick(
        filters=filters,
        strategy=args.strategy,
        obtainer=args.provider,
        openrouter_api_key=api_key if args.provider == "openrouter" else None,
        vercel_api_key=api_key if args.provider == "vercel" else None,
        cache=not args.no_cache,
        refresh=args.refresh,
    )

    if args.json:
        from dataclasses import asdict
        payload = asdict(sel)
        payload["model"] = asdict(sel.model)
        if sel.score is not None:
            payload["score"] = asdict(sel.score)
        print(json.dumps(payload, indent=2, default=str))
    else:
        print(f"{sel.model.id}\t${sel.prompt_price:.8f}/tok prompt\t"
              f"${sel.completion_price:.8f}/tok completion\tctx {sel.model.context_length}")
        if sel.score:
            print(f"  score: {sel.score.source}/{sel.score.task_type or sel.score.benchmark_type} = {sel.score.score}")
        print(f"  candidates considered: {sel.candidates_considered}  strategy: {sel.strategy}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
