"""Tests for the filter DSL and apply_filters."""

from __future__ import annotations

from anypick import BenchmarkScore, Model, apply_filters, pred
from anypick.filter import ModelFilters, BenchmarkThreshold
from conftest import models_from_fixture, scores_from_fixture


def test_no_filter_keeps_all():
    models = models_from_fixture()
    scores = scores_from_fixture()
    assert len(apply_filters(models, scores, None)) == len(models)


def test_empty_spec_keeps_all():
    models = models_from_fixture()
    scores = scores_from_fixture()
    assert len(apply_filters(models, scores, ModelFilters())) == len(models)


def test_max_prompt_price():
    models = models_from_fixture()
    scores = scores_from_fixture()
    f = ModelFilters(max_prompt_price=1e-6)
    survivors = apply_filters(models, scores, f)
    assert all(m.prompt_price <= 1e-6 for m in survivors)
    # llama-3.3-70b at 1e-7 must survive
    assert "meta-llama/llama-3.3-70b-instruct" in {m.id for m in survivors}


def test_min_context_length():
    models = models_from_fixture()
    f = ModelFilters(min_context_length=200_000)
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all(m.context_length >= 200_000 for m in survivors)
    # qwen3.8-27b has 262144
    assert "qwen/qwen3.8-27b" in {m.id for m in survivors}


def test_modalities_in():
    models = models_from_fixture()
    f = ModelFilters(modalities_in=["image"])
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all("image" in m.input_modalities for m in survivors)
    assert "openai/gpt-4o" in {m.id for m in survivors}


def test_requires_tools():
    models = models_from_fixture()
    f = ModelFilters(requires_tools=True)
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all(m.supports_tools for m in survivors)


def test_exclude_ids():
    models = models_from_fixture()
    f = ModelFilters(exclude_ids=["openai/gpt-4o"])
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert "openai/gpt-4o" not in {m.id for m in survivors}


def test_min_benchmark_drops_scoreless_models():
    models = models_from_fixture()
    scores = scores_from_fixture(task_type="coding")
    f = ModelFilters(min_benchmark=BenchmarkThreshold(task_type="coding", min=60))
    survivors = apply_filters(models, scores, f)
    ids = {m.id for m in survivors}
    # gpt-4o (65.8), llama (60.0), qwen (80.5) all pass; everything else dropped
    assert "openai/gpt-4o" in ids
    assert "meta-llama/llama-3.3-70b-instruct" in ids
    assert "qwen/qwen3.8-27b" in ids
    # a random unbenchmarked model is dropped
    assert "google/gemini-flash-1.5" not in ids


def test_benchmark_scope_without_bound_keeps_scoreless():
    models = models_from_fixture()
    scores = scores_from_fixture(task_type="coding")
    # only scope, no min/max -> keep models that have at least one matching score
    f = ModelFilters(min_benchmark=BenchmarkThreshold(task_type="coding"))
    survivors = apply_filters(models, scores, f)
    ids = {m.id for m in survivors}
    assert "openai/gpt-4o" in ids
    # unbenchmarked model should NOT be kept (no matching score)
    assert "google/gemini-flash-1.5" not in ids


def test_predicate_combinators():
    models = models_from_fixture()
    scores = scores_from_fixture(task_type="coding")
    f = (pred.price_below(prompt=1e-6)
         & pred.context_at_least(128_000)
         & pred.supports_tools()
         & pred.benchmark_above(task_type="coding", min=60))
    survivors = apply_filters(models, scores, f)
    ids = {m.id for m in survivors}
    # llama (1e-7 prompt, 131072 ctx, tools, 60.0 coding) passes
    assert "meta-llama/llama-3.3-70b-instruct" in ids
    # gpt-4o prompt price 2.5e-6 > 1e-6 -> dropped
    assert "openai/gpt-4o" not in ids


def test_predicate_negation_and_or():
    models = models_from_fixture()
    scores = scores_from_fixture()
    f = ~pred.supports_tools()
    survivors = apply_filters(models, scores, f)
    assert all(not m.supports_tools for m in survivors)

    f2 = pred.supports_tools() | pred.supports_structured_outputs()
    survivors2 = apply_filters(models, scores, f2)
    assert all(m.supports_tools or m.supports_structured_outputs for m in survivors2)


def test_expected_cost_filter():
    models = models_from_fixture()
    scores = scores_from_fixture()
    f = ModelFilters(max_expected_cost=1e-6, expected_cost_weights=(1.0, 1.0))
    survivors = apply_filters(models, scores, f)
    for m in survivors:
        assert m.prompt_price + m.completion_price <= 1e-6 + 1e-15


def test_benchmark_source_scope():
    models = models_from_fixture()
    scores = scores_from_fixture()
    f = ModelFilters(min_benchmark=BenchmarkThreshold(source="openrouter", benchmark_type="gpqa_diamond", min=0.5))
    survivors = apply_filters(models, scores, f)
    ids = {m.id for m in survivors}
    # gpt-4o gpqa accuracy 0.72 >= 0.5; llama 0.41 < 0.5
    assert "openai/gpt-4o" in ids
    assert "meta-llama/llama-3.3-70b-instruct" not in ids
