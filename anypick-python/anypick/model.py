"""Normalized, provider-agnostic types.

These two structs are the *currency* of anypick: every obtainer translates its
raw payload into them, and the filter/pick layers operate on them and nothing
else. See docs/architecture.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Model:
    """A normalized model record.

    Attributes:
        id: canonical model id, e.g. ``"openai/gpt-4o"``; join key for scores.
        name: human-readable label.
        context_length: maximum input tokens.
        input_modalities: e.g. ``["text","image"]``.
        output_modalities: e.g. ``["text"]``.
        prompt_price: USD per token for prompt input.
        completion_price: USD per token for completion output.
        cache_read_price: USD per token for cached prompt reads (0.0 if n/a).
        supports_tools: derived from the provider's capability parameters.
        supports_reasoning: derived.
        supports_structured_outputs: derived.
        raw: the original provider payload, kept for power users.
    """

    id: str
    name: str
    context_length: int
    input_modalities: list[str] = field(default_factory=list)
    output_modalities: list[str] = field(default_factory=list)
    prompt_price: float = 0.0
    completion_price: float = 0.0
    cache_read_price: float = 0.0
    supports_tools: bool = False
    supports_reasoning: bool = False
    supports_structured_outputs: bool = False
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    @property
    def expected_cost(self) -> float:
        """``prompt_price + completion_price`` (equal-weight expected cost)."""
        return self.prompt_price + self.completion_price


@dataclass(frozen=True)
class BenchmarkScore:
    """A single benchmark measurement for a model.

    A model may carry several of these (different sources / task types /
    benchmark types). ``score`` is on the *source's native scale* — see
    docs/architecture.md §"Why score is not re-normalized".

    Attributes:
        model_id: joins to ``Model.id``.
        source: e.g. ``"artificial-analysis"``, ``"openrouter"``.
        task_type: ``"coding" | "intelligence" | "agentic"`` or None.
        benchmark_type: e.g. ``"gpqa_diamond"`` or None.
        score: the single comparable number for this source.
        accuracy: raw accuracy when the source exposes it (else None).
        stddev: standard deviation of accuracy when available.
        raw: the original provider payload.
    """

    model_id: str
    source: str
    score: float
    task_type: str | None = None
    benchmark_type: str | None = None
    accuracy: float | None = None
    stddev: float | None = None
    raw: dict[str, Any] = field(default_factory=dict, repr=False)


def group_scores_by_model(
    scores: list[BenchmarkScore],
) -> dict[str, list[BenchmarkScore]]:
    """Group benchmark scores by ``model_id``."""
    out: dict[str, list[BenchmarkScore]] = {}
    for s in scores:
        out.setdefault(s.model_id, []).append(s)
    return out
