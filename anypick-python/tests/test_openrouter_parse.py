"""Tests for OpenRouter payload parsing (offline, against fixtures)."""

from __future__ import annotations

from conftest import models_from_fixture, scores_from_fixture


def test_models_fixture_parses():
    models = models_from_fixture()
    assert len(models) == 414
    ids = {m.id for m in models}
    assert "openai/gpt-4o" in ids
    assert "meta-llama/llama-3.3-70b-instruct" in ids


def test_model_field_mapping():
    models = {m.id: m for m in models_from_fixture()}
    gpt4o = models["openai/gpt-4o"]
    assert gpt4o.name == "OpenAI: GPT-4o"
    assert gpt4o.context_length == 128000
    assert gpt4o.prompt_price == 0.0000025
    assert gpt4o.completion_price == 0.00001
    assert gpt4o.cache_read_price == 0.00000125
    assert gpt4o.supports_tools is True
    assert gpt4o.supports_structured_outputs is True
    assert "text" in gpt4o.input_modalities
    assert "image" in gpt4o.input_modalities


def test_model_with_no_cache_read_price():
    # llama-3.3-70b has only prompt+completion
    models = {m.id: m for m in models_from_fixture()}
    llama = models["meta-llama/llama-3.3-70b-instruct"]
    assert llama.cache_read_price == 0.0
    assert llama.prompt_price == 0.0000001
    assert llama.supports_tools is True


def test_model_raw_preserved():
    models = {m.id: m for m in models_from_fixture()}
    gpt4o = models["openai/gpt-4o"]
    assert gpt4o.raw["id"] == "openai/gpt-4o"
    assert "supported_parameters" in gpt4o.raw


def test_benchmarks_fixture_parses():
    scores = scores_from_fixture(task_type="coding")
    ids = {s.model_id for s in scores}
    assert "openai/gpt-4o" in ids
    assert "meta-llama/llama-3.3-70b-instruct" in ids


def test_artificial_analysis_score_uses_task_type():
    scores = scores_from_fixture(task_type="coding")
    aa = [s for s in scores if s.source == "artificial-analysis" and s.model_id == "openai/gpt-4o"][0]
    # coding_index for gpt-4o is 65.8
    assert aa.score == 65.8
    assert aa.task_type == "coding"
    assert aa.benchmark_type is None


def test_artificial_analysis_falls_back_to_intelligence():
    scores = scores_from_fixture(task_type=None)
    aa = [s for s in scores if s.source == "artificial-analysis" and s.model_id == "openai/gpt-4o"][0]
    assert aa.score == 71.2  # intelligence_index


def test_openrouter_score_uses_accuracy():
    scores = scores_from_fixture()
    or_scores = [s for s in scores if s.source == "openrouter" and s.model_id == "openai/gpt-4o"]
    gpqa = [s for s in or_scores if s.benchmark_type == "gpqa_diamond"][0]
    assert gpqa.score == 0.72
    assert gpqa.accuracy == 0.72
    assert gpqa.stddev == 0.03
    assert gpqa.task_type is None
