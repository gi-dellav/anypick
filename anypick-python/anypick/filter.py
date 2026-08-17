"""Filter DSL: spec form (:class:`ModelFilters`) and predicate combinators.

Both forms compile to the same :data:`Predicate` callable and are applied by
:func:`apply_filters`. See docs/filters.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Callable, Union

from .model import BenchmarkScore, Model, group_scores_by_model

# A predicate over (model, that model's scores).
Predicate = Callable[[Model, list[BenchmarkScore]], bool]


# ---------------------------------------------------------------------------
# Benchmark threshold
# ---------------------------------------------------------------------------


@dataclass
class BenchmarkThreshold:
    """A benchmark constraint, optionally scoped by source/task/benchmark."""

    source: str | None = None
    task_type: str | None = None
    benchmark_type: str | None = None
    min: float | None = None
    max: float | None = None

    def matches(self, s: BenchmarkScore) -> bool:
        """Does this score fall under the threshold's scope?"""
        if self.source is not None and s.source != self.source:
            return False
        if self.task_type is not None and s.task_type != self.task_type:
            return False
        if self.benchmark_type is not None and s.benchmark_type != self.benchmark_type:
            return False
        return True

    def has_bound(self) -> bool:
        return self.min is not None or self.max is not None


# ---------------------------------------------------------------------------
# Spec form
# ---------------------------------------------------------------------------


@dataclass
class ModelFilters:
    """The ergonomic filter spec. Every field is optional (None = no constraint)."""

    max_prompt_price: float | None = None
    max_completion_price: float | None = None
    max_expected_cost: float | None = None
    expected_cost_weights: tuple[float, float] = (1.0, 1.0)
    min_context_length: int | None = None
    modalities_in: list[str] | None = None
    output_modalities_in: list[str] | None = None
    requires_tools: bool | None = None
    requires_reasoning: bool | None = None
    requires_structured_outputs: bool | None = None
    exclude_ids: list[str] | None = None
    min_benchmark: BenchmarkThreshold | None = None
    max_benchmark: BenchmarkThreshold | None = None

    def to_predicate(self) -> Predicate:
        """Compile this spec to a single :data:`Predicate`."""
        clauses: list[Predicate] = []

        if self.max_prompt_price is not None:
            maxp = self.max_prompt_price
            clauses.append(lambda m, s: m.prompt_price <= maxp)
        if self.max_completion_price is not None:
            maxc = self.max_completion_price
            clauses.append(lambda m, s: m.completion_price <= maxc)
        if self.max_expected_cost is not None:
            a, b = self.expected_cost_weights
            mx = self.max_expected_cost
            clauses.append(lambda m, s: a * m.prompt_price + b * m.completion_price <= mx)
        if self.min_context_length is not None:
            ctx = self.min_context_length
            clauses.append(lambda m, s: m.context_length >= ctx)
        if self.modalities_in is not None:
            want = set(self.modalities_in)
            clauses.append(lambda m, s: want.issubset(set(m.input_modalities)))
        if self.output_modalities_in is not None:
            want = set(self.output_modalities_in)
            clauses.append(lambda m, s: want.issubset(set(m.output_modalities)))
        if self.requires_tools:
            clauses.append(lambda m, s: m.supports_tools)
        if self.requires_reasoning:
            clauses.append(lambda m, s: m.supports_reasoning)
        if self.requires_structured_outputs:
            clauses.append(lambda m, s: m.supports_structured_outputs)
        if self.exclude_ids:
            bad = set(self.exclude_ids)
            clauses.append(lambda m, s: m.id not in bad)
        if self.min_benchmark is not None:
            bt = self.min_benchmark
            clauses.append(benchmark_predicate(bt, want_above=True))
        if self.max_benchmark is not None:
            bt = self.max_benchmark
            clauses.append(benchmark_predicate(bt, want_above=False))

        return _all(clauses)

    def serialize(self) -> dict[str, Any]:
        """Serializable form, for inclusion in :class:`~anypick.pick.Selection`."""
        d = asdict(self)
        # expected_cost_weights is a tuple; make it JSON-friendly
        d["expected_cost_weights"] = list(self.expected_cost_weights)
        return d


# ---------------------------------------------------------------------------
# Predicate combinators
# ---------------------------------------------------------------------------


class _Composed:
    """A composable predicate supporting ``&``, ``|``, ``~``."""

    def __init__(self, fn: Predicate) -> None:
        self.fn = fn

    def __call__(self, model: Model, scores: list[BenchmarkScore]) -> bool:
        return self.fn(model, scores)

    def __and__(self, other: "Predicate | _Composed") -> "_Composed":
        o = _wrap(other)
        return _Composed(lambda m, s: self.fn(m, s) and o.fn(m, s))

    def __or__(self, other: "Predicate | _Composed") -> "_Composed":
        o = _wrap(other)
        return _Composed(lambda m, s: self.fn(m, s) or o.fn(m, s))

    def __invert__(self) -> "_Composed":
        return _Composed(lambda m, s: not self.fn(m, s))


def _wrap(p: "Predicate | _Composed") -> _Composed:
    if isinstance(p, _Composed):
        return p
    return _Composed(p)


def _all(clauses: list[Predicate]) -> Predicate:
    """AND a list of predicates; empty list = keep-all."""
    if not clauses:
        return _Composed(lambda m, s: True)
    compiled = [_wrap(c) for c in clauses]

    def fn(m: Model, s: list[BenchmarkScore]) -> bool:
        return all(c(m, s) for c in compiled)

    return _Composed(fn)


def benchmark_predicate(
    threshold: BenchmarkThreshold, *, want_above: bool
) -> Predicate:
    """Build a predicate that checks a model has a matching score above/below bound.

    *Unknown != zero*: a model with no matching score is kept iff the threshold
    specifies no bound (i.e. it is a pure scoping filter). When a bound is
    present, scoreless models are dropped.
    """
    def fn(_m: Model, scores: list[BenchmarkScore]) -> bool:
        candidates = [s for s in scores if threshold.matches(s)]
        if not threshold.has_bound():
            # Pure scope: keep models that have at least one matching score.
            return len(candidates) > 0
        for s in candidates:
            if want_above and threshold.min is not None and s.score >= threshold.min:
                return True
            if not want_above and threshold.max is not None and s.score <= threshold.max:
                return True
        return False

    return _Composed(fn)


# A module-level namespace so users can write ``from anypick import pred``.
class _PredNamespace:
    """Factory namespace for predicate combinators."""

    @staticmethod
    def price_below(
        *, prompt: float | None = None, completion: float | None = None
    ) -> _Composed:
        clauses: list[Predicate] = []
        if prompt is not None:
            clauses.append(lambda m, s: m.prompt_price <= prompt)
        if completion is not None:
            clauses.append(lambda m, s: m.completion_price <= completion)
        return _all(clauses)

    @staticmethod
    def expected_cost_below(max: float, weights: tuple[float, float] = (1.0, 1.0)) -> _Composed:
        a, b = weights
        return _Composed(lambda m, s: a * m.prompt_price + b * m.completion_price <= max)

    @staticmethod
    def context_at_least(n: int) -> _Composed:
        return _Composed(lambda m, s: m.context_length >= n)

    @staticmethod
    def modalities_in(want: list[str]) -> _Composed:
        w = set(want)
        return _Composed(lambda m, s: w.issubset(set(m.input_modalities)))

    @staticmethod
    def output_modalities_in(want: list[str]) -> _Composed:
        w = set(want)
        return _Composed(lambda m, s: w.issubset(set(m.output_modalities)))

    @staticmethod
    def supports_tools() -> _Composed:
        return _Composed(lambda m, s: m.supports_tools)

    @staticmethod
    def supports_reasoning() -> _Composed:
        return _Composed(lambda m, s: m.supports_reasoning)

    @staticmethod
    def supports_structured_outputs() -> _Composed:
        return _Composed(lambda m, s: m.supports_structured_outputs)

    @staticmethod
    def id_not_in(ids: list[str]) -> _Composed:
        bad = set(ids)
        return _Composed(lambda m, s: m.id not in bad)

    @staticmethod
    def benchmark_above(
        *,
        source: str | None = None,
        task_type: str | None = None,
        benchmark_type: str | None = None,
        min: float | None = None,
    ) -> _Composed:
        bt = BenchmarkThreshold(
            source=source, task_type=task_type, benchmark_type=benchmark_type, min=min
        )
        return benchmark_predicate(bt, want_above=True)

    @staticmethod
    def benchmark_below(
        *,
        source: str | None = None,
        task_type: str | None = None,
        benchmark_type: str | None = None,
        max: float | None = None,
    ) -> _Composed:
        bt = BenchmarkThreshold(
            source=source, task_type=task_type, benchmark_type=benchmark_type, max=max
        )
        return benchmark_predicate(bt, want_above=False)


pred = _PredNamespace()


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------


FilterSpec = Union[ModelFilters, Predicate, _Composed, None]


def _coerce(filters: FilterSpec) -> _Composed:
    if filters is None:
        return _Composed(lambda m, s: True)
    if isinstance(filters, ModelFilters):
        return _wrap(filters.to_predicate())
    return _wrap(filters)


def apply_filters(
    models: list[Model],
    scores: list[BenchmarkScore],
    filters: FilterSpec = None,
) -> list[Model]:
    """Apply a filter spec to ``(models, scores)`` and return the survivors.

    ``filters`` may be a :class:`ModelFilters`, a raw :data:`Predicate`, or
    ``None`` (keep all).
    """
    fn = _coerce(filters)
    grouped = group_scores_by_model(scores)
    return [m for m in models if fn(m, grouped.get(m.id, []))]


def survivors_by_clause(
    models: list[Model],
    scores: list[BenchmarkScore],
    filters: ModelFilters,
) -> dict[str, int]:
    """Compute per-clause surviving counts (cumulative, in application order).

    Used to populate :class:`~anypick.errors.NoModelsFound`.
    """
    grouped = group_scores_by_model(scores)
    current = list(models)
    out: dict[str, int] = {"_start": len(current)}

    clauses = _spec_clauses(filters)
    for name, clause in clauses:
        current = [m for m in current if clause(m, grouped.get(m.id, []))]
        out[name] = len(current)
    out.pop("_start", None)
    return out


def _spec_clauses(filters: ModelFilters) -> list[tuple[str, Predicate]]:
    """Enumerate (clause-name, predicate) pairs in application order."""
    out: list[tuple[str, Predicate]] = []
    f = filters

    if f.max_prompt_price is not None:
        mx = f.max_prompt_price
        out.append(("max_prompt_price", _Composed(lambda m, s: m.prompt_price <= mx)))
    if f.max_completion_price is not None:
        mx = f.max_completion_price
        out.append(("max_completion_price", _Composed(lambda m, s: m.completion_price <= mx)))
    if f.max_expected_cost is not None:
        a, b = f.expected_cost_weights
        mx = f.max_expected_cost
        out.append(("max_expected_cost", _Composed(lambda m, s: a * m.prompt_price + b * m.completion_price <= mx)))
    if f.min_context_length is not None:
        n = f.min_context_length
        out.append(("min_context_length", _Composed(lambda m, s: m.context_length >= n)))
    if f.modalities_in is not None:
        w = set(f.modalities_in)
        out.append(("modalities_in", _Composed(lambda m, s: w.issubset(set(m.input_modalities)))))
    if f.output_modalities_in is not None:
        w = set(f.output_modalities_in)
        out.append(("output_modalities_in", _Composed(lambda m, s: w.issubset(set(m.output_modalities)))))
    if f.requires_tools:
        out.append(("requires_tools", _Composed(lambda m, s: m.supports_tools)))
    if f.requires_reasoning:
        out.append(("requires_reasoning", _Composed(lambda m, s: m.supports_reasoning)))
    if f.requires_structured_outputs:
        out.append(("requires_structured_outputs", _Composed(lambda m, s: m.supports_structured_outputs)))
    if f.exclude_ids:
        bad = set(f.exclude_ids)
        out.append(("exclude_ids", _Composed(lambda m, s: m.id not in bad)))
    if f.min_benchmark is not None:
        out.append(("min_benchmark", benchmark_predicate(f.min_benchmark, want_above=True)))
    if f.max_benchmark is not None:
        out.append(("max_benchmark", benchmark_predicate(f.max_benchmark, want_above=False)))
    return out
