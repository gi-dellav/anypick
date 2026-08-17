"""Shared test helpers: build Model/BenchmarkScore lists from fixtures."""

from __future__ import annotations

import json
import os
from typing import Any

from anypick.model import BenchmarkScore, Model
from anypick.openrouter import _map_benchmark, _map_model

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def load_fixture(name: str) -> Any:
    with open(os.path.join(FIXTURES, name), "r", encoding="utf-8") as fh:
        return json.load(fh)


def models_from_fixture() -> list[Model]:
    payload = load_fixture("models.json")
    return [_map_model(item) for item in payload.get("data", [])]


def scores_from_fixture(task_type: str | None = "coding") -> list[BenchmarkScore]:
    payload = load_fixture("benchmarks.json")
    return [_map_benchmark(item, task_type) for item in payload.get("data", [])]
