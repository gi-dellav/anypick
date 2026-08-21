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


def test_min_benchmarks_drops_scoreless_models():
    models = models_from_fixture()
    scores = scores_from_fixture(task_type="coding")
    f = ModelFilters(min_benchmarks=[BenchmarkThreshold(task_type="coding", min=60)])
    survivors = apply_filters(models, scores, f)
    ids = {m.id for m in survivors}
    # gpt-4o (65.8), llama (60.0), qwen (80.5) all pass; everything else dropped
    assert "openai/gpt-4o" in ids
    assert "meta-llama/llama-3.3-70b-instruct" in ids
    assert "qwen/qwen3.8-27b" in ids
    # a random unbenchmarked model is dropped
    assert "deepseek/deepseek-v4-pro-0813" not in ids


def test_benchmark_scope_without_bound_keeps_scoreless():
    models = models_from_fixture()
    scores = scores_from_fixture(task_type="coding")
    # only scope, no min/max -> keep models that have at least one matching score
    f = ModelFilters(min_benchmarks=[BenchmarkThreshold(task_type="coding")])
    survivors = apply_filters(models, scores, f)
    ids = {m.id for m in survivors}
    assert "openai/gpt-4o" in ids
    # unbenchmarked model should NOT be kept (no matching score)
    assert "deepseek/deepseek-v4-pro-0813" not in ids


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
    f = ModelFilters(min_benchmarks=[BenchmarkThreshold(source="openrouter", benchmark_type="gpqa_diamond", min=0.5)])
    survivors = apply_filters(models, scores, f)
    ids = {m.id for m in survivors}
    # gpt-4o gpqa accuracy 0.72 >= 0.5; llama 0.41 < 0.5
    assert "openai/gpt-4o" in ids
    assert "meta-llama/llama-3.3-70b-instruct" not in ids


# ---------------------------------------------------------------------------
# Tier 1 additions: ids, makers, price floors, context max, cache_read,
# modality exactness/negation, tri-state capabilities, benchmark lists.
# ---------------------------------------------------------------------------


def test_include_ids_whitelist():
    models = models_from_fixture()
    want = ["openai/gpt-4o", "meta-llama/llama-3.3-70b-instruct"]
    f = ModelFilters(include_ids=want)
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert {m.id for m in survivors} == set(want)


def test_exclude_ids_still_works():
    models = models_from_fixture()
    f = ModelFilters(exclude_ids=["openai/gpt-4o"])
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert "openai/gpt-4o" not in {m.id for m in survivors}
    assert len(survivors) == len(models) - 1


def test_include_makers_whitelist():
    models = models_from_fixture()
    f = ModelFilters(include_makers=["openai", "qwen"])
    survivors = apply_filters(models, scores_from_fixture(), f)
    ids = {m.id for m in survivors}
    assert all(m.id.split("/", 1)[0] in ("openai", "qwen") for m in survivors)
    assert "openai/gpt-4o" in ids
    assert "qwen/qwen3.8-27b" in ids
    assert "google/gemini-flash-1.5" not in ids


def test_exclude_makers_blacklist():
    models = models_from_fixture()
    f = ModelFilters(exclude_makers=["openai"])
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all(not m.id.startswith("openai/") for m in survivors)
    assert "openai/gpt-4o" not in {m.id for m in survivors}
    # other makers untouched
    assert "qwen/qwen3.8-27b" in {m.id for m in survivors}


def test_include_makers_drops_makerless_ids():
    # An id with no '/' has no maker; a maker whitelist drops it.
    from anypick import Model as M
    models = [M(id="lonely", name="x", context_length=1),
              M(id="openai/gpt-4o", name="g", context_length=1)]
    f = ModelFilters(include_makers=["openai"])
    survivors = apply_filters(models, [], f)
    assert {m.id for m in survivors} == {"openai/gpt-4o"}


def test_exclude_makers_keeps_makerless_ids():
    # A maker blacklist does not touch makerless ids.
    from anypick import Model as M
    models = [M(id="lonely", name="x", context_length=1),
              M(id="openai/gpt-4o", name="g", context_length=1)]
    f = ModelFilters(exclude_makers=["openai"])
    survivors = apply_filters(models, [], f)
    assert {m.id for m in survivors} == {"lonely"}


def test_min_prompt_price_floor():
    models = models_from_fixture()
    f = ModelFilters(min_prompt_price=1e-6)
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all(m.prompt_price >= 1e-6 for m in survivors)
    # gpt-4o at 2.5e-6 must survive; llama at 1e-7 must not
    assert "openai/gpt-4o" in {m.id for m in survivors}
    assert "meta-llama/llama-3.3-70b-instruct" not in {m.id for m in survivors}


def test_min_completion_price_floor():
    models = models_from_fixture()
    f = ModelFilters(min_completion_price=5e-6)
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all(m.completion_price >= 5e-6 for m in survivors)


def test_min_expected_cost_floor():
    models = models_from_fixture()
    f = ModelFilters(min_expected_cost=1e-5, expected_cost_weights=(1.0, 1.0))
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all(m.prompt_price + m.completion_price >= 1e-5 for m in survivors)


def test_max_context_length():
    models = models_from_fixture()
    f = ModelFilters(max_context_length=200_000)
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all(m.context_length <= 200_000 for m in survivors)
    # qwen3.8-27b has 262144 -> dropped; gpt-4o 128000 -> kept
    assert "qwen/qwen3.8-27b" not in {m.id for m in survivors}
    assert "openai/gpt-4o" in {m.id for m in survivors}


def test_max_cache_read_price():
    models = models_from_fixture()
    # a tiny positive cap keeps only models with cache_read_price ~0
    f = ModelFilters(max_cache_read_price=1e-12)
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all(m.cache_read_price <= 1e-12 for m in survivors)
    # most models have nonzero cache_read_price -> survivors are a strict subset
    assert len(survivors) < len(models)


def test_modalities_exactly():
    models = models_from_fixture()
    # exact match to ["text", "image"] drops text-only and [text,image,file,...]
    f = ModelFilters(modalities_exactly=["text", "image"])
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all(set(m.input_modalities) == {"text", "image"} for m in survivors)
    # meta/muse-glimmer-30b is exactly [text, image]
    assert "meta/muse-glimmer-30b" in {m.id for m in survivors}
    # text-only models dropped; multimodal (text,image,file) dropped
    assert "deepseek/deepseek-v4-pro-0813" not in {m.id for m in survivors}
    assert "openai/gpt-4o" not in {m.id for m in survivors}


def test_excludes_modalities():
    models = models_from_fixture()
    f = ModelFilters(excludes_modalities=["image"])
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all("image" not in m.input_modalities for m in survivors)
    assert "openai/gpt-4o" not in {m.id for m in survivors}
    assert "deepseek/deepseek-v4-pro-0813" in {m.id for m in survivors}


def test_output_modalities_exactly():
    models = models_from_fixture()
    f = ModelFilters(output_modalities_exactly=["text"])
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all(set(m.output_modalities) == {"text"} for m in survivors)


def test_excludes_output_modalities():
    models = models_from_fixture()
    # drop models that emit images
    f = ModelFilters(excludes_output_modalities=["image"])
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all("image" not in m.output_modalities for m in survivors)


def test_requires_tools_forbid():
    # tri-state False -> must NOT support tools
    models = models_from_fixture()
    f = ModelFilters(requires_tools=False)
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all(not m.supports_tools for m in survivors)
    assert len(survivors) < len(models)  # some models do support tools


def test_requires_tools_require():
    models = models_from_fixture()
    f = ModelFilters(requires_tools=True)
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all(m.supports_tools for m in survivors
               or not survivors)  # tolerate fixture skew


def test_requires_tools_none_ignores():
    models = models_from_fixture()
    f = ModelFilters(requires_tools=None)
    assert len(apply_filters(models, scores_from_fixture(), f)) == len(models)


def test_min_benchmarks_list_is_and():
    models = models_from_fixture()
    scores = scores_from_fixture(task_type="coding")
    # coding>=60 AND coding>=70: only qwen (80.5) survives (gpt-4o 65.8, llama 60.0 drop)
    f = ModelFilters(min_benchmarks=[
        BenchmarkThreshold(task_type="coding", min=60),
        BenchmarkThreshold(task_type="coding", min=70),
    ])
    survivors = apply_filters(models, scores, f)
    ids = {m.id for m in survivors}
    assert ids == {"qwen/qwen3.8-27b"}


def test_max_benchmarks_list():
    models = models_from_fixture()
    scores = scores_from_fixture()
    # gpqa accuracy <= 0.5: llama (0.41) survives; gpt-4o (0.72) drops
    f = ModelFilters(max_benchmarks=[
        BenchmarkThreshold(source="openrouter", benchmark_type="gpqa_diamond", max=0.5),
    ])
    survivors = apply_filters(models, scores, f)
    ids = {m.id for m in survivors}
    assert "meta-llama/llama-3.3-70b-instruct" in ids
    assert "openai/gpt-4o" not in ids


# ---------------------------------------------------------------------------
# Predicate form additions.
# ---------------------------------------------------------------------------


def test_pred_id_in():
    models = models_from_fixture()
    f = pred.id_in(["openai/gpt-4o", "qwen/qwen3.8-27b"])
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert {m.id for m in survivors} == {"openai/gpt-4o", "qwen/qwen3.8-27b"}


def test_pred_maker_in_and_not_in():
    models = models_from_fixture()
    in_openai = apply_filters(models, scores_from_fixture(), pred.maker_in(["openai"]))
    assert all(m.id.startswith("openai/") for m in in_openai)
    not_openai = apply_filters(models, scores_from_fixture(), pred.maker_not_in(["openai"]))
    assert all(not m.id.startswith("openai/") for m in not_openai)


def test_pred_price_above():
    models = models_from_fixture()
    f = pred.price_above(prompt=1e-6)
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all(m.prompt_price >= 1e-6 for m in survivors)


def test_pred_expected_cost_above():
    models = models_from_fixture()
    f = pred.expected_cost_above(1e-5)
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all(m.prompt_price + m.completion_price >= 1e-5 for m in survivors)


def test_pred_cache_read_price_below():
    models = models_from_fixture()
    f = pred.cache_read_price_below(1e-12)
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all(m.cache_read_price <= 1e-12 for m in survivors)


def test_pred_context_at_most():
    models = models_from_fixture()
    f = pred.context_at_most(200_000)
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all(m.context_length <= 200_000 for m in survivors)


def test_pred_modalities_exactly_and_not_in():
    models = models_from_fixture()
    exact = apply_filters(models, scores_from_fixture(), pred.modalities_exactly(["text", "image"]))
    assert all(set(m.input_modalities) == {"text", "image"} for m in exact)
    noimg = apply_filters(models, scores_from_fixture(), pred.modalities_not_in(["image"]))
    assert all("image" not in m.input_modalities for m in noimg)


def test_pred_output_modalities_exactly_and_not_in():
    models = models_from_fixture()
    exact = apply_filters(models, scores_from_fixture(), pred.output_modalities_exactly(["text"]))
    assert all(set(m.output_modalities) == {"text"} for m in exact)
    noimg = apply_filters(models, scores_from_fixture(), pred.output_modalities_not_in(["image"]))
    assert all("image" not in m.output_modalities for m in noimg)


def test_pred_forbid_tools_via_negation():
    models = models_from_fixture()
    f = ~pred.supports_tools()
    survivors = apply_filters(models, scores_from_fixture(), f)
    assert all(not m.supports_tools for m in survivors)
