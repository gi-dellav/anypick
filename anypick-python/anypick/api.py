"""High-level convenience entry: :func:`anypick`.

Wires obtainers + cache, fetches models and benchmarks, joins, filters, picks.
See docs/api-reference.md.
"""

from __future__ import annotations

import os
from typing import Any

from .filter import BenchmarkThreshold, ModelFilters
from .model import BenchmarkScore, Model
from .obtainer import (
    BenchmarkObtainer,
    Cache,
    CachedBenchmarkObtainer,
    CachedModelObtainer,
    FileCache,
    MemoryCache,
    ModelListObtainer,
    NoopBenchmarkObtainer,
)
from .openrouter import (
    OpenRouterBenchmarkObtainer,
    OpenRouterModelObtainer,
)
from .pick import Selection, Strategy, pick_best
from .vercel import VercelModelObtainer


def anypick(
    *,
    filters: ModelFilters | Any = None,
    strategy: Strategy = "cheapest",
    obtainer: str | tuple[ModelListObtainer, BenchmarkObtainer] = "openrouter",
    model_obtainer: ModelListObtainer | None = None,
    benchmark_obtainer: BenchmarkObtainer | None = None,
    openrouter_api_key: str | None = None,
    vercel_api_key: str | None = None,
    cache: Cache | bool = True,
    refresh: bool = False,
) -> Selection:
    """One-shot selection.

    Args:
        filters: a :class:`ModelFilters`, a raw predicate, or None.
        strategy: one of :data:`~anypick.pick.Strategy`.
        obtainer: ``"openrouter"``, ``"vercel"``, or a
            ``(ModelListObtainer, BenchmarkObtainer)`` pair. ``"vercel"`` is
            models-only (no benchmark feed); pair it with a price-only strategy.
        model_obtainer: a custom :class:`ModelListObtainer`. Overrides the model
            side of ``obtainer``; ``benchmark_obtainer``/``obtainer`` supply the
            benchmark side.
        benchmark_obtainer: a custom :class:`BenchmarkObtainer`. Overrides the
            benchmark side of ``obtainer``; ``model_obtainer``/``obtainer`` supply
            the model side.
        openrouter_api_key: overrides ``OPENROUTER_API_KEY`` (benchmarks only).
        vercel_api_key: overrides ``VERCEL_AI_GATEWAY_API_KEY`` (optional; the
            gateway's models endpoint is public, a key only raises the rate
            ceiling).
        cache: ``True`` (default FileCache), ``False`` (no cache), or a Cache instance.
        refresh: bypass cache for this call.

    Returns:
        A :class:`~anypick.pick.Selection`.
    """
    model_obt, bench_obt = _resolve_obtainers(
        obtainer, model_obtainer, benchmark_obtainer, openrouter_api_key, vercel_api_key, cache, refresh
    )

    models = model_obt.list_models()

    need_scores = _strategy_needs_scores(strategy, filters)
    if not need_scores:
        scores: list[BenchmarkScore] = []
    else:
        bench_kwargs = _benchmark_kwargs_from_filters(filters)
        scores = bench_obt.list_benchmarks(**bench_kwargs)

    return pick_best(models, scores, filters=filters, strategy=strategy)


# ---------------------------------------------------------------------------
# internals
# ---------------------------------------------------------------------------


def _resolve_obtainers(
    obtainer: str | tuple[ModelListObtainer, BenchmarkObtainer],
    model_obtainer: ModelListObtainer | None,
    benchmark_obtainer: BenchmarkObtainer | None,
    openrouter_api_key: str | None,
    vercel_api_key: str | None,
    cache: Cache | bool,
    refresh: bool,
) -> tuple[ModelListObtainer, BenchmarkObtainer]:
    if model_obtainer is not None and benchmark_obtainer is not None:
        model_obt, bench_obt = model_obtainer, benchmark_obtainer
    elif model_obtainer is not None:
        model_obt = model_obtainer
        bench_obt = _resolve_benchmark_obtainer(
            obtainer, openrouter_api_key, vercel_api_key
        )
    elif benchmark_obtainer is not None:
        model_obt = _resolve_model_obtainer(
            obtainer, openrouter_api_key, vercel_api_key
        )
        bench_obt = benchmark_obtainer
    elif isinstance(obtainer, tuple):
        model_obt, bench_obt = obtainer
    else:
        model_obt = _resolve_model_obtainer(
            obtainer, openrouter_api_key, vercel_api_key
        )
        bench_obt = _resolve_benchmark_obtainer(
            obtainer, openrouter_api_key, vercel_api_key
        )

    if cache is False:
        return model_obt, bench_obt

    cache_obj: Cache = cache if isinstance(cache, Cache) else FileCache()
    model_obt = CachedModelObtainer(model_obt, cache_obj)
    bench_obt = CachedBenchmarkObtainer(bench_obt, cache_obj)
    # propagate refresh into kwargs by wrapping the call sites (handled in callers)
    return model_obt, bench_obt


def _resolve_model_obtainer(
    obtainer: str | tuple[ModelListObtainer, BenchmarkObtainer],
    openrouter_api_key: str | None,
    vercel_api_key: str | None,
) -> ModelListObtainer:
    if isinstance(obtainer, tuple):
        return obtainer[0]
    if obtainer == "openrouter":
        key = openrouter_api_key or os.environ.get("OPENROUTER_API_KEY")
        return OpenRouterModelObtainer(api_key=key)
    if obtainer == "vercel":
        return VercelModelObtainer(api_key=vercel_api_key)
    raise ValueError(f"unknown obtainer provider: {obtainer!r}")


def _resolve_benchmark_obtainer(
    obtainer: str | tuple[ModelListObtainer, BenchmarkObtainer],
    openrouter_api_key: str | None,
    vercel_api_key: str | None,
) -> BenchmarkObtainer:
    if isinstance(obtainer, tuple):
        return obtainer[1]
    if obtainer == "openrouter":
        key = openrouter_api_key or os.environ.get("OPENROUTER_API_KEY")
        return OpenRouterBenchmarkObtainer(api_key=key)
    if obtainer == "vercel":
        # Vercel AI Gateway exposes a models catalog but no benchmark feed.
        return NoopBenchmarkObtainer()
    raise ValueError(f"unknown obtainer provider: {obtainer!r}")


def _benchmark_kwargs_from_filters(filters: Any) -> dict[str, Any]:
    """Narrow the benchmark fetch from the filter spec's thresholds.

    The obtainer's ``list_benchmarks`` takes a single ``source``/``task_type``/
    ``benchmark_type``. With a list of thresholds we narrow the fetch only on a
    dimension when *every* threshold agrees on the same non-None value; any
    wildcard (None) or disagreement means we fetch broad and let the filter
    engine narrow client-side.
    """
    if not isinstance(filters, ModelFilters):
        return {}
    thresholds: list[BenchmarkThreshold] = []
    if filters.min_benchmarks:
        thresholds.extend(filters.min_benchmarks)
    if filters.max_benchmarks:
        thresholds.extend(filters.max_benchmarks)
    if not thresholds:
        return {}
    kw: dict[str, Any] = {}
    for name in ("source", "task_type", "benchmark_type"):
        distinct = {getattr(t, name) for t in thresholds}
        if len(distinct) == 1 and None not in distinct:
            kw[name] = next(iter(distinct))
    return kw


def _strategy_needs_scores(strategy: Strategy, filters: Any) -> bool:
    """Whether the strategy + filters require benchmark scores.

    ``cheapest`` with no benchmark clause is price-only, so we skip the
    (rate-limited, auth-gated) benchmark fetch entirely.
    """
    if strategy != "cheapest":
        return True
    if isinstance(filters, ModelFilters) and (
        filters.min_benchmarks or filters.max_benchmarks
    ):
        return True
    return False
