"""Tests for pick_best and strategies.

Uses a small controlled model set (the three models in the benchmark fixture)
so strategy assertions are deterministic. Fixture parsing is covered separately
in test_openrouter_parse.py.
"""

from __future__ import annotations

import pytest

from anypick import BenchmarkThreshold, Model, ModelFilters, NoModelsFound, pick_best
from conftest import scores_from_fixture


# A controlled catalog: the three models the benchmark fixture scores, with
# prices matching the fixture's `pricing` blocks.
def _catalog() -> list[Model]:
    return [
        Model(
            id="openai/gpt-4o",
            name="GPT-4o",
            context_length=128000,
            input_modalities=["text", "image"],
            output_modalities=["text"],
            prompt_price=2.5e-6,
            completion_price=1.0e-5,
            supports_tools=True,
            supports_structured_outputs=True,
        ),
        Model(
            id="meta-llama/llama-3.3-70b-instruct",
            name="Llama 3.3 70B",
            context_length=131072,
            input_modalities=["text"],
            output_modalities=["text"],
            prompt_price=1.0e-7,
            completion_price=3.2e-7,
            supports_tools=True,
        ),
        Model(
            id="qwen/qwen3.8-27b",
            name="Qwen3.8 27B",
            context_length=262144,
            input_modalities=["text", "image"],
            output_modalities=["text"],
            prompt_price=4.5e-7,
            completion_price=3.2e-6,
            supports_tools=True,
        ),
    ]


def test_cheapest_picks_lowest_price():
    models = _catalog()
    scores = scores_from_fixture(task_type="coding")
    f = ModelFilters(requires_tools=True, min_context_length=128_000)
    sel = pick_best(models, scores, f, "cheapest")
    assert sel.model.id == "meta-llama/llama-3.3-70b-instruct"
    assert sel.score is None
    assert sel.expected_cost == sel.model.prompt_price + sel.model.completion_price
    assert sel.candidates_considered == 3


def test_cheapest_with_floor():
    models = _catalog()
    scores = scores_from_fixture(task_type="coding")
    f = ModelFilters(
        requires_tools=True,
        min_context_length=128_000,
        min_benchmark=BenchmarkThreshold(task_type="coding", min=60),
    )
    sel = pick_best(models, scores, f, "cheapest_with_floor")
    # all three pass the floor (65.8, 60.0, 80.5); cheapest is llama
    assert sel.model.id == "meta-llama/llama-3.3-70b-instruct"
    assert sel.score is not None
    assert sel.score.score == 60.0
    assert sel.score.task_type == "coding"


def test_cheapest_with_floor_excludes_below_threshold():
    models = _catalog()
    scores = scores_from_fixture(task_type="coding")
    f = ModelFilters(
        requires_tools=True,
        min_context_length=128_000,
        min_benchmark=BenchmarkThreshold(task_type="coding", min=61),
    )
    sel = pick_best(models, scores, f, "cheapest_with_floor")
    # llama (60.0) now dropped; cheapest of {gpt-4o, qwen} = qwen (4.5e-7 < 2.5e-6)
    assert sel.model.id == "qwen/qwen3.8-27b"
    assert sel.score.score == 80.5


def test_best_score_picks_highest():
    models = _catalog()
    scores = scores_from_fixture(task_type="coding")
    f = ModelFilters(
        requires_tools=True,
        min_context_length=128_000,
        min_benchmark=BenchmarkThreshold(task_type="coding"),
    )
    sel = pick_best(models, scores, f, "best_score")
    assert sel.model.id == "qwen/qwen3.8-27b"
    assert sel.score.score == 80.5


def test_best_value():
    models = _catalog()
    scores = scores_from_fixture(task_type="coding")
    f = ModelFilters(
        requires_tools=True,
        min_context_length=128_000,
        min_benchmark=BenchmarkThreshold(task_type="coding"),
    )
    sel = pick_best(models, scores, f, "best_value")
    # value = cost/score; llama has the lowest (best) ratio
    #   llama:  (1.0e-7 + 3.2e-7) / 60.0   ~ 7.0e-9
    #   gpt4o:  (2.5e-6 + 1.0e-5) / 65.8  ~ 1.9e-7
    #   qwen:   (4.5e-7 + 3.2e-6) / 80.5  ~ 4.5e-8
    assert sel.model.id == "meta-llama/llama-3.3-70b-instruct"


def test_best_score_uses_source_scoping():
    models = _catalog()
    scores = scores_from_fixture()  # mixed sources
    f = ModelFilters(
        requires_tools=True,
        min_context_length=128_000,
        min_benchmark=BenchmarkThreshold(source="openrouter", benchmark_type="gpqa_diamond"),
    )
    sel = pick_best(models, scores, f, "best_score")
    # only openrouter gpqa scores: gpt-4o 0.72, llama 0.41 -> gpt-4o wins
    assert sel.model.id == "openai/gpt-4o"
    assert sel.score.score == 0.72
    assert sel.score.source == "openrouter"


def test_no_models_found_carries_counts():
    models = _catalog()
    scores = scores_from_fixture(task_type="coding")
    # absurdly high context -> nothing survives
    f = ModelFilters(min_context_length=10**18, requires_tools=True)
    with pytest.raises(NoModelsFound) as exc_info:
        pick_best(models, scores, f, "cheapest")
    counts = exc_info.value.survivors_by_clause
    assert "min_context_length" in counts
    assert counts["min_context_length"] == 0


def test_cheapest_with_floor_without_threshold_errors():
    models = _catalog()
    scores = scores_from_fixture()
    f = ModelFilters(requires_tools=True)
    with pytest.raises(ValueError, match="min_benchmark"):
        pick_best(models, scores, f, "cheapest_with_floor")


def test_best_score_without_threshold_errors():
    models = _catalog()
    scores = scores_from_fixture()
    with pytest.raises(ValueError, match="min_benchmark"):
        pick_best(models, scores, None, "best_score")


def test_predicate_filter_accepted_by_pick_best():
    from anypick import pred
    models = _catalog()
    scores = scores_from_fixture(task_type="coding")
    f = pred.price_below(prompt=1e-6) & pred.supports_tools() & pred.benchmark_above(task_type="coding", min=60)
    sel = pick_best(models, scores, f, "cheapest")
    assert sel.model.id == "meta-llama/llama-3.3-70b-instruct"


def test_unknown_strategy_raises():
    models = _catalog()
    scores = scores_from_fixture()
    with pytest.raises(ValueError, match="unknown strategy"):
        pick_best(models, scores, None, "fanciest")  # type: ignore[arg-type]


def test_tiebreak_is_deterministic_by_id():
    m1 = Model(id="aaa/zzz", name="A", context_length=1, prompt_price=1.0, completion_price=1.0)
    m2 = Model(id="aaa/aaa", name="B", context_length=1, prompt_price=1.0, completion_price=1.0)
    sel = pick_best([m1, m2], [], None, "cheapest")
    assert sel.model.id == "aaa/aaa"  # lower id wins the tie


def test_negative_price_models_skipped_by_cost_strategies():
    # OpenRouter reports -1 for meta-router models like 'openrouter/auto'.
    auto = Model(id="openrouter/auto", name="Auto", context_length=200000,
                 prompt_price=-1.0, completion_price=-1.0, supports_tools=True)
    llama = Model(id="meta-llama/llama-3.3-70b-instruct", name="Llama",
                 context_length=131072, prompt_price=1.0e-7, completion_price=3.2e-7,
                 supports_tools=True)
    sel = pick_best([auto, llama], [], None, "cheapest")
    assert sel.model.id == "meta-llama/llama-3.3-70b-instruct"


def test_all_negative_price_raises_no_models_found():
    auto = Model(id="openrouter/auto", name="Auto", context_length=200000,
                 prompt_price=-1.0, completion_price=-1.0, supports_tools=True)
    with pytest.raises(NoModelsFound):
        pick_best([auto], [], None, "cheapest")
