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
)
from .openrouter import (
    OpenRouterBenchmarkObtainer,
    OpenRouterModelObtainer,
)
from .pick import Selection, Strategy, pick_best


def anypick(
    *,
    filters: ModelFilters | Any = None,
    strategy: Strategy = "cheapest",
    obtainer: str | tuple[ModelListObtainer, BenchmarkObtainer] = "openrouter",
    openrouter_api_key: str | None = None,
    cache: Cache | bool = True,
    refresh: bool = False,
) -> Selection:
    """One-shot selection.

    Args:
        filters: a :class:`ModelFilters`, a raw predicate, or None.
        strategy: one of :data:`~anypick.pick.Strategy`.
        obtainer: ``"openrouter"`` or a ``(ModelListObtainer, BenchmarkObtainer)`` pair.
        openrouter_api_key: overrides ``OPENROUTER_API_KEY`` (benchmarks only).
        cache: ``True`` (default FileCache), ``False`` (no cache), or a Cache instance.
        refresh: bypass cache for this call.

    Returns:
        A :class:`~anypick.pick.Selection`.
    """
    model_obt, bench_obt = _resolve_obtainers(obtainer, openrouter_api_key, cache, refresh)

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
    api_key: str | None,
    cache: Cache | bool,
    refresh: bool,
) -> tuple[ModelListObtainer, BenchmarkObtainer]:
    if isinstance(obtainer, tuple):
        model_obt, bench_obt = obtainer
    elif obtainer == "openrouter":
        key = api_key or os.environ.get("OPENROUTER_API_KEY")
        model_obt = OpenRouterModelObtainer(api_key=key)
        bench_obt = OpenRouterBenchmarkObtainer(api_key=key)
    else:
        raise ValueError(f"unknown obtainer provider: {obtainer!r}")

    if cache is False:
        return model_obt, bench_obt

    cache_obj: Cache = cache if isinstance(cache, Cache) else FileCache()
    model_obt = CachedModelObtainer(model_obt, cache_obj)
    bench_obt = CachedBenchmarkObtainer(bench_obt, cache_obj)
    # propagate refresh into kwargs by wrapping the call sites (handled in callers)
    return model_obt, bench_obt


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
