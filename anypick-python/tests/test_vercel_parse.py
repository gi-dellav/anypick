"""Tests for the Vercel AI Gateway payload parsing (offline, against fixtures)."""

from __future__ import annotations

import json
import os

from anypick import anypick, ModelFilters, NoModelsFound
from anypick.vercel import VercelModelObtainer, _map_model
from conftest import load_fixture


def _models():
    payload = load_fixture("vercel_models.json")
    return [_map_model(item) for item in payload["data"]]


def test_models_fixture_parses():
    models = _models()
    ids = {m.id for m in models}
    assert ids == {
        "google/gemini-3.1-pro-preview",
        "openai/gpt-5.6-sol",
        "anthropic/claude-opus-4.3",
        "black-forest-labs/flux-pro-1.1",
        "openai/text-embedding-3-large",
        "meta/llama-4-free",
    }


def test_field_mapping_language_model():
    models = {m.id: m for m in _models()}
    gemini = models["google/gemini-3.1-pro-preview"]
    assert gemini.name == "Gemini 3.1 Pro Preview"
    assert gemini.context_length == 1_000_000
    assert gemini.prompt_price == 0.000002
    assert gemini.completion_price == 0.000012
    assert gemini.cache_read_price == 0.0000002
    # capability derivation from tags
    assert gemini.supports_tools is True       # "tool-use"
    assert gemini.supports_reasoning is True   # "reasoning"
    assert gemini.supports_structured_outputs is False  # no signal on this endpoint
    # input modalities: text + vision->image + file-input->file
    assert "text" in gemini.input_modalities
    assert "image" in gemini.input_modalities
    assert "file" in gemini.input_modalities
    assert gemini.output_modalities == ["text"]


def test_pricing_without_cache_read():
    models = {m.id: m for m in _models()}
    gpt = models["openai/gpt-5.6-sol"]
    assert gpt.cache_read_price == 0.0
    assert gpt.prompt_price == 0.000005
    assert gpt.supports_reasoning is True
    assert gpt.supports_tools is True
    # no vision tag -> only text input
    assert gpt.input_modalities == ["text"]


def test_free_model_parses_to_zero():
    models = {m.id: m for m in _models()}
    llama = models["meta/llama-4-free"]
    assert llama.prompt_price == 0.0
    assert llama.completion_price == 0.0
    assert llama.supports_tools is True
    assert llama.supports_reasoning is False


def test_image_model_modalities_and_pricing():
    models = {m.id: m for m in _models()}
    flux = models["black-forest-labs/flux-pro-1.1"]
    # type=image -> output modality "image"; no input/output token pricing
    assert flux.output_modalities == ["image"]
    assert flux.prompt_price == 0.0   # no "input" pricing key
    assert flux.completion_price == 0.0
    assert flux.context_length == 0
    assert flux.supports_tools is False
    # the image-price field survives in raw
    assert flux.raw["pricing"]["image"] == "0.04"


def test_embedding_model_has_no_output_modality():
    models = {m.id: m for m in _models()}
    emb = models["openai/text-embedding-3-large"]
    # embeddings aren't representable as a chat output modality
    assert emb.output_modalities == []
    assert emb.input_modalities == ["text"]
    assert emb.prompt_price == 0.00000013
    assert emb.completion_price == 0.0


def test_raw_payload_preserved():
    models = {m.id: m for m in _models()}
    gemini = models["google/gemini-3.1-pro-preview"]
    assert gemini.raw["id"] == "google/gemini-3.1-pro-preview"
    assert gemini.raw["type"] == "language"
    assert "tags" in gemini.raw


def test_vercel_obtainer_fakes_via_monkeypatch(monkeypatch):
    """VercelModelObtainer.list_models parses the fetched JSON envelope."""
    payload = load_fixture("vercel_models.json")

    class _FakeResp:
        status_code = 200
        def json(self):
            return payload

    monkeypatch.setattr(
        "anypick._http.requests.request",
        lambda method, url, **kw: _FakeResp(),
    )
    obt = VercelModelObtainer(api_key="fake")
    models = obt.list_models()
    assert len(models) == 6
    assert {m.id for m in models} == {
        "google/gemini-3.1-pro-preview",
        "openai/gpt-5.6-sol",
        "anthropic/claude-opus-4.3",
        "black-forest-labs/flux-pro-1.1",
        "openai/text-embedding-3-large",
        "meta/llama-4-free",
    }


def test_vercel_obtainer_sends_bearer_when_keyed(monkeypatch):
    payload = load_fixture("vercel_models.json")
    captured = {}

    class _FakeResp:
        status_code = 200
        def json(self):
            return payload

    def _capture(method, url, **kw):
        captured["headers"] = kw.get("headers")
        return _FakeResp()

    monkeypatch.setattr("anypick._http.requests.request", _capture)
    VercelModelObtainer(api_key="sk-test").list_models()
    assert captured["headers"]["Authorization"] == "Bearer sk-test"


def test_vercel_obtainer_omits_auth_header_when_no_key(monkeypatch):
    payload = load_fixture("vercel_models.json")
    captured = {}

    class _FakeResp:
        status_code = 200
        def json(self):
            return payload

    def _capture(method, url, **kw):
        captured["headers"] = kw.get("headers")
        return _FakeResp()

    monkeypatch.setattr("anypick._http.requests.request", _capture)
    monkeypatch.delenv("VERCEL_AI_GATEWAY_API_KEY", raising=False)
    VercelModelObtainer().list_models()
    assert "Authorization" not in captured["headers"]


def test_anypick_vercel_provider_picks_cheapest(monkeypatch):
    payload = load_fixture("vercel_models.json")

    class _FakeResp:
        status_code = 200
        def json(self):
            return payload

    monkeypatch.setattr("anypick._http.requests.request", lambda *a, **kw: _FakeResp())
    sel = anypick(
        filters=ModelFilters(
            min_context_length=128_000,
            requires_tools=True,
        ),
        strategy="cheapest",
        obtainer=(VercelModelObtainer(api_key=None), __import__("anypick").NoopBenchmarkObtainer()),
        cache=False,
    )
    # free Llama 4 (0.0 prices) is cheapest among tool-capable language models
    assert sel.model.id == "meta/llama-4-free"
    assert sel.prompt_price == 0.0
    assert sel.score is None  # no benchmark feed


def test_anypick_vercel_string_obtainer(monkeypatch):
    """anypick(obtainer='vercel') wires VercelModelObtainer + NoopBenchmarkObtainer."""
    payload = load_fixture("vercel_models.json")

    class _FakeResp:
        status_code = 200
        def json(self):
            return payload

    monkeypatch.setattr("anypick._http.requests.request", lambda *a, **kw: _FakeResp())
    monkeypatch.delenv("VERCEL_AI_GATEWAY_API_KEY", raising=False)

    sel = anypick(
        filters=ModelFilters(min_context_length=128_000, requires_tools=True),
        strategy="cheapest",
        obtainer="vercel",
        cache=False,
    )
    assert sel.model.id == "meta/llama-4-free"
