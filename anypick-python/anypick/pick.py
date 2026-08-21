"""``pick_best`` and the strategies / :class:`Selection`.

Pure module — no I/O. See docs/strategies.md.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal, Sequence

from .errors import NoModelsFound
from .filter import (
    BenchmarkThreshold,
    FilterSpec,
    ModelFilters,
    _coerce,
    survivors_by_clause,
)
from .model import BenchmarkScore, Model, group_scores_by_model

Strategy = Literal["cheapest", "cheapest_with_floor", "best_score", "best_value"]


@dataclass
class Selection:
    """The result of a pick.

    Attributes:
        model: the chosen :class:`Model`.
        score: the benchmark score that drove the pick, or None.
        prompt_price / completion_price / expected_cost: convenience copies.
        candidates_considered: how many models survived filtering.
        strategy: the strategy name used.
        filters_applied: serialized spec, for reproducibility.
    """

    model: Model
    score: BenchmarkScore | None
    prompt_price: float
    completion_price: float
    expected_cost: float
    candidates_considered: int
    strategy: str
    filters_applied: dict[str, Any]


def pick_best(
    models: list[Model],
    scores: list[BenchmarkScore],
    filters: FilterSpec = None,
    strategy: Strategy = "cheapest",
) -> Selection:
    """Filter then pick the best model via ``strategy``.

    Raises:
        NoModelsFound: if the filtered set is empty (carries per-clause counts).
        ValueError: if a benchmark-dependent strategy is used without a
            ``min_benchmarks`` (or equivalent ``pred.benchmark_*``) threshold.
    """
    if strategy not in ("cheapest", "cheapest_with_floor", "best_score", "best_value"):
        raise ValueError(f"unknown strategy: {strategy!r}")

    # Apply filters.
    spec = filters if isinstance(filters, ModelFilters) else None
    fn = _coerce(filters)
    grouped = group_scores_by_model(scores)
    candidates = [m for m in models if fn(m, grouped.get(m.id, []))]

    if not candidates:
        counts: dict[str, int]
        if spec is not None:
            counts = survivors_by_clause(models, scores, spec)
        else:
            counts = {"filters": 0}
        raise NoModelsFound(counts)

    weights = (1.0, 1.0)
    if spec is not None and spec.expected_cost_weights:
        weights = spec.expected_cost_weights
    alpha, beta = weights

    def cost(m: Model) -> float:
        return alpha * m.prompt_price + beta * m.completion_price

    if strategy == "cheapest":
        priced = _with_known_price(candidates)
        if not priced:
            raise NoModelsFound({"priced": 0})
        best = _min(priced, key=lambda m: (cost(m), m.id))
        chosen_score = None
    elif strategy == "cheapest_with_floor":
        threshold = _require_threshold(spec, filters, strategy)
        eligible = _with_score(candidates, grouped, threshold, want_above=True)
        eligible = _with_known_price(eligible)
        if not eligible:
            raise NoModelsFound({"min_benchmarks[0]": 0})
        best = _min(eligible, key=lambda m: (cost(m), m.id))
        chosen_score = _best_matching_score(best, grouped.get(best.id, []), threshold)
    elif strategy == "best_score":
        threshold = _require_threshold(spec, filters, strategy)
        eligible = _with_score(candidates, grouped, threshold, want_above=True, require_bound=False)
        if not eligible:
            raise NoModelsFound({"best_score": 0})
        best = _max(eligible, key=lambda m: (_score_of(m, grouped, threshold), -cost(m), m.id))
        chosen_score = _best_matching_score(best, grouped.get(best.id, []), threshold)
    else:  # best_value
        threshold = _require_threshold(spec, filters, strategy)
        eligible = _with_known_price(
            _with_score(candidates, grouped, threshold, want_above=True, require_bound=False)
        )
        if not eligible:
            raise NoModelsFound({"best_value": 0})
        best = _min(
            eligible,
            # minimize cost/score (higher score => better value); score>0 guaranteed
            key=lambda m: (cost(m) / _score_of(m, grouped, threshold), m.id),
        )
        chosen_score = _best_matching_score(best, grouped.get(best.id, []), threshold)

    filters_applied = spec.serialize() if spec is not None else {}
    return Selection(
        model=best,
        score=chosen_score,
        prompt_price=best.prompt_price,
        completion_price=best.completion_price,
        expected_cost=cost(best),
        candidates_considered=len(candidates),
        strategy=strategy,
        filters_applied=filters_applied,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _require_threshold(
    spec: ModelFilters | None, filters: FilterSpec, strategy: str
) -> BenchmarkThreshold:
    """Resolve the benchmark threshold a benchmark-dependent strategy ranks on.

    With a list of thresholds, the strategy ranks on the *first* one (the
    primary quality criterion). The remaining thresholds still act as filters
    (applied by ``apply_filters``) but do not drive ranking.
    """
    if spec is not None:
        if spec.min_benchmarks:
            return spec.min_benchmarks[0]
        if spec.max_benchmarks:
            return spec.max_benchmarks[0]
    raise ValueError(
        f"strategy {strategy!r} requires a min_benchmarks threshold (or a "
        "pred.benchmark_* threshold) to know which score to rank on."
    )


def _with_score(
    models: list[Model],
    grouped: dict[str, list[BenchmarkScore]],
    threshold: BenchmarkThreshold,
    *,
    want_above: bool,
    require_bound: bool = True,
) -> list[Model]:
    """Keep models that have a score passing the threshold.

    When the threshold has no bound (pure scope), keep any model with a
    matching score. Otherwise require at least one matching score to satisfy
    the bound.
    """
    out: list[Model] = []
    for m in models:
        scores = grouped.get(m.id, [])
        candidates = [s for s in scores if threshold.matches(s)]
        if not candidates:
            continue
        if not threshold.has_bound():
            out.append(m)
            continue
        ok = any(_passes(s, threshold, want_above) for s in candidates)
        if ok:
            out.append(m)
    return out


def _passes(s: BenchmarkScore, t: BenchmarkThreshold, want_above: bool) -> bool:
    if want_above and t.min is not None:
        return s.score >= t.min
    if not want_above and t.max is not None:
        return s.score <= t.max
    return False


def _score_of(
    m: Model, grouped: dict[str, list[BenchmarkScore]], threshold: BenchmarkThreshold
) -> float:
    """The best matching score for ``m`` (max), or 0.0 if none."""
    scores = grouped.get(m.id, [])
    candidates = [s for s in scores if threshold.matches(s)]
    if not candidates:
        return 0.0
    return max(s.score for s in candidates)


def _best_matching_score(
    m: Model, scores: list[BenchmarkScore], threshold: BenchmarkThreshold
) -> BenchmarkScore | None:
    candidates = [s for s in scores if threshold.matches(s)]
    if not candidates:
        return None
    return max(candidates, key=lambda s: s.score)


def _with_known_price(models: list[Model]) -> list[Model]:
    """Drop models whose prompt/completion price is negative (sentinel 'N/A').

    OpenRouter reports ``-1`` for meta-router models like ``openrouter/auto``
    whose pricing varies per request. Such models can't be ranked by cost, so
    cost-based strategies skip them.
    """
    return [m for m in models if m.prompt_price >= 0 and m.completion_price >= 0]


def _min(seq: Sequence[Model], key=lambda m: m.id) -> Model:  # type: ignore[assignment]
    return min(seq, key=key)


def _max(seq: Sequence[Model], key=lambda m: m.id) -> Model:  # type: ignore[assignment]
    return max(seq, key=key)
