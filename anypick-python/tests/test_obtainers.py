"""Tests for the obtainer protocols, cache, and the anypick() wiring."""

from __future__ import annotations

import os

import pytest

from anypick import (
    BenchmarkThreshold,
    FileCache,
    MemoryCache,
    ModelFilters,
    NoModelsFound,
    anypick,
)
from anypick.model import BenchmarkScore, Model
from anypick.obtainer import (
    CachedBenchmarkObtainer,
    CachedModelObtainer,
)
from conftest import models_from_fixture, scores_from_fixture


# A pair of in-memory fake obtainers fed from fixtures.


class _FakeModelObtainer:
    def __init__(self, models: list[Model]) -> None:
        self.models = models
        self.calls = 0

    def list_models(self, **opts) -> list[Model]:
        self.calls += 1
        return list(self.models)


class _FakeBenchmarkObtainer:
    def __init__(self, scores: list[BenchmarkScore]) -> None:
        self.scores = scores
        self.calls = 0

    def list_benchmarks(self, *, source=None, task_type=None, benchmark_type=None, **opts):
        self.calls += 1
        out = list(self.scores)
        if source:
            out = [s for s in out if s.source == source]
        if task_type:
            out = [s for s in out if s.task_type == task_type]
        if benchmark_type:
            out = [s for s in out if s.benchmark_type == benchmark_type]
        return out


def test_anypick_with_fake_obtainers():
    models = models_from_fixture()
    scores = scores_from_fixture(task_type="coding")
    mo, bo = _FakeModelObtainer(models), _FakeBenchmarkObtainer(scores)
    sel = anypick(
        filters=ModelFilters(
            requires_tools=True,
            min_context_length=128_000,
            min_benchmark=BenchmarkThreshold(task_type="coding", min=60),
        ),
        strategy="cheapest_with_floor",
        obtainer=(mo, bo),
        cache=False,
    )
    assert sel.model.id == "meta-llama/llama-3.3-70b-instruct"
    assert sel.score.score == 60.0


def test_anypick_cheapest_works_without_key_when_no_benchmarks_needed():
    # No min_benchmark, strategy=cheapest -> benchmarks are optional and
    # must NOT be fetched.
    models = models_from_fixture()
    scores: list[BenchmarkScore] = []
    mo, bo = _FakeModelObtainer(models), _FakeBenchmarkObtainer(scores)
    sel = anypick(
        filters=ModelFilters(requires_tools=True, min_context_length=128_000),
        strategy="cheapest",
        obtainer=(mo, bo),
        cache=False,
    )
    assert bo.calls == 0           # benchmarks endpoint never hit
    assert sel.score is None        # no score drove a price-only pick
    assert sel.model.prompt_price >= 0  # sentinel-priced 'auto' excluded by cost strategy


def test_anypick_raises_no_models_when_filtered_empty():
    models = models_from_fixture()
    scores = scores_from_fixture()
    mo, bo = _FakeModelObtainer(models), _FakeBenchmarkObtainer(scores)
    with pytest.raises(NoModelsFound):
        anypick(
            filters=ModelFilters(min_context_length=10**18),  # nothing has this
            strategy="cheapest",
            obtainer=(mo, bo),
            cache=False,
        )


def test_cache_avoids_second_fetch():
    models = models_from_fixture()
    scores = scores_from_fixture()
    cache = MemoryCache()
    mo = _FakeModelObtainer(models)
    bo = _FakeBenchmarkObtainer(scores)
    cmo = CachedModelObtainer(mo, cache, ttl=3600)
    cbo = CachedBenchmarkObtainer(bo, cache, ttl=3600)

    m1 = cmo.list_models()
    assert mo.calls == 1
    m2 = cmo.list_models()
    assert mo.calls == 1  # served from cache
    assert len(m2) == len(m1)

    s1 = cbo.list_benchmarks()
    assert bo.calls == 1
    s2 = cbo.list_benchmarks()
    assert bo.calls == 1


def test_cache_refresh_bypasses():
    models = models_from_fixture()
    cache = MemoryCache()
    mo = _FakeModelObtainer(models)
    cmo = CachedModelObtainer(mo, cache, ttl=3600)
    cmo.list_models()
    assert mo.calls == 1
    cmo.list_models(refresh=True)
    assert mo.calls == 2


def test_file_cache_roundtrip(tmp_path):
    models = models_from_fixture()
    cache = FileCache(dir=str(tmp_path))
    mo = _FakeModelObtainer(models)
    cmo = CachedModelObtainer(mo, cache, ttl=3600)
    cmo.list_models()
    # new obtainer, same cache dir -> should hit
    mo2 = _FakeModelObtainer(models)
    cmo2 = CachedModelObtainer(mo2, cache, ttl=3600)
    out = cmo2.list_models()
    assert mo2.calls == 0  # served from disk
    assert len(out) == len(models)


def test_unknown_obtainer_raises():
    with pytest.raises(ValueError, match="unknown obtainer"):
        anypick(obtainer="mintlify", cache=False)
