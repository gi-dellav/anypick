"""OpenRouter provider implementations.

See docs/providers/openrouter.md for the endpoint contracts, response shapes,
and mapping rules these classes implement.

* :class:`OpenRouterModelObtainer` — ``GET /api/v1/models`` (no auth).
* :class:`OpenRouterBenchmarkObtainer` — ``GET /api/v1/benchmarks`` (key required,
  rate-limited 30/min·500/day).
"""

from __future__ import annotations

import os
import time
from typing import Any

import requests

from .errors import BadAuth, ProviderError, RateLimited
from .model import BenchmarkScore, Model

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"

# artificial-analysis task_type -> index field on the item
_AA_INDEX_FIELDS = {
    "coding": "coding_index",
    "intelligence": "intelligence_index",
    "agentic": "agentic_index",
}

# design-arena: the API narrows by `arena` (models|builders|agents) and
# `category` (codecategories, uicomponent, gamedev, 3d, dataviz, image, video,
# svg). OpenRouter does not publish a fixed response shape for this source, so
# the mapper is deliberately defensive: it tries the obvious numeric fields in
# order and records the category under `benchmark_type`.
_DA_SCORE_FIELDS = ("score", "elo", "arena_elo", "category_score")


def _f(value: Any) -> float:
    """Parse a pricing/score string-or-number to float; ''/None -> 0.0."""
    if value is None or value == "":
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _get(obj: dict[str, Any], key: str, default: Any = None) -> Any:
    return obj.get(key, default) if isinstance(obj, dict) else default


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class OpenRouterModelObtainer:
    """List models from OpenRouter's public ``/models`` endpoint."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        api_key: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def list_models(self, **opts: Any) -> list[Model]:
        url = f"{self.base_url}/models"
        headers = {"Accept": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        resp = _request("GET", url, headers=headers, timeout=self.timeout)
        data = resp.get("data") or []
        return [_map_model(item) for item in data]


def _map_model(item: dict[str, Any]) -> Model:
    pricing = _get(item, "pricing", {}) or {}
    arch = _get(item, "architecture", {}) or {}
    supported = _get(item, "supported_parameters", []) or []
    return Model(
        id=item.get("id", ""),
        name=item.get("name", item.get("id", "")),
        context_length=int(_get(item, "context_length", 0) or 0),
        input_modalities=list(_get(arch, "input_modalities", []) or []),
        output_modalities=list(_get(arch, "output_modalities", []) or []),
        prompt_price=_f(pricing.get("prompt")),
        completion_price=_f(pricing.get("completion")),
        cache_read_price=_f(pricing.get("input_cache_read")),
        supports_tools="tools" in supported,
        supports_reasoning="reasoning" in supported,
        supports_structured_outputs="structured_outputs" in supported,
        raw=item,
    )


# ---------------------------------------------------------------------------
# Benchmarks
# ---------------------------------------------------------------------------


class OpenRouterBenchmarkObtainer:
    """List benchmarks from OpenRouter's ``/benchmarks`` endpoint.

    Requires an API key (read ``OPENROUTER_API_KEY`` if not passed). Rate-limited
    to 30 req/min per key and 500 req/day per account; a 429 triggers exponential
    backoff before surfacing :class:`~anypick.errors.RateLimited`.
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        max_retries: int = 3,
    ) -> None:
        self.api_key = api_key or os.environ.get("OPENROUTER_API_KEY")
        if not self.api_key:
            # We allow construction without a key so the obtainer can be
            # instantiated lazily; the failure surfaces at call time as BadAuth
            # if the endpoint really needs it.
            pass
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries

    def list_benchmarks(
        self,
        *,
        source: str | None = None,
        task_type: str | None = None,
        benchmark_type: str | None = None,
        arena: str | None = None,
        category: str | None = None,
        max_results: int | None = None,
        **opts: Any,
    ) -> list[BenchmarkScore]:
        if not self.api_key:
            raise BadAuth("OpenRouter benchmarks require an API key (set OPENROUTER_API_KEY or pass api_key=).")

        url = f"{self.base_url}/benchmarks"
        headers = {"Authorization": f"Bearer {self.api_key}", "Accept": "application/json"}
        # Server-side query params per the /benchmarks OpenAPI:
        #   source, task_type, arena, category, max_results
        # NOTE: ``benchmark_type`` is *not* a server query param — it is a
        # response field on ``openrouter``-source items. We narrow on it
        # client-side below to honor the Protocol's narrowing hint.
        params: dict[str, str] = {}
        if source:
            params["source"] = source
        if task_type:
            params["task_type"] = task_type
        if arena:
            params["arena"] = arena
        if category:
            params["category"] = category
        if max_results is not None:
            params["max_results"] = str(max_results)

        resp = _request(
            "GET",
            url,
            headers=headers,
            params=params or None,
            timeout=self.timeout,
            max_retries=self.max_retries,
        )
        data = resp.get("data") or []
        scores = [_map_benchmark(item, task_type) for item in data]
        if benchmark_type:
            scores = [s for s in scores if s.benchmark_type == benchmark_type]
        return scores


def _map_benchmark(item: dict[str, Any], requested_task_type: str | None) -> BenchmarkScore:
    src = item.get("source", "")
    model_id = item.get("model_permaslug", "")
    if src == "artificial-analysis":
        field = _AA_INDEX_FIELDS.get(requested_task_type or "", "intelligence_index")
        score = _f(item.get(field))
        return BenchmarkScore(
            model_id=model_id,
            source="artificial-analysis",
            task_type=requested_task_type,
            benchmark_type=None,
            score=score,
            accuracy=None,
            stddev=None,
            raw=item,
        )
    if src == "openrouter":
        return BenchmarkScore(
            model_id=model_id,
            source="openrouter",
            task_type=None,
            benchmark_type=item.get("benchmark_type"),
            score=_f(item.get("accuracy")),
            accuracy=_f(item.get("accuracy")) if item.get("accuracy") is not None else None,
            stddev=_f(item.get("accuracy_stddev")) if item.get("accuracy_stddev") is not None else None,
            raw=item,
        )
    if src == "design-arena":
        # OpenRouter doesn't publish a fixed design-arena item shape. Narrowing
        # happens server-side via `arena`/`category` query params; here we record
        # the category under `benchmark_type` and pick the first available
        # numeric score field.
        category = item.get("category")
        score = 0.0
        for field in _DA_SCORE_FIELDS:
            if item.get(field) is not None:
                score = _f(item.get(field))
                break
        return BenchmarkScore(
            model_id=model_id,
            source="design-arena",
            task_type=None,
            benchmark_type=category,
            score=score,
            accuracy=None,
            stddev=None,
            raw=item,
        )
    # Unknown source: keep what we can, score from any obvious numeric field.
    return BenchmarkScore(
        model_id=model_id,
        source=src or "unknown",
        task_type=None,
        benchmark_type=item.get("benchmark_type"),
        score=_f(item.get("score")),
        accuracy=None,
        stddev=None,
        raw=item,
    )


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def _request(
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    params: dict[str, str] | None = None,
    timeout: float = 30.0,
    max_retries: int = 0,
) -> dict[str, Any]:
    """Perform an HTTP request with auth/rate-limit error mapping + backoff."""
    backoff = 0.5
    last_exc: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            resp = requests.request(method, url, headers=headers, params=params, timeout=timeout)
        except requests.RequestException as exc:
            last_exc = exc
            if attempt < max_retries:
                time.sleep(backoff)
                backoff *= 2
                continue
            raise ProviderError(0, f"network error: {exc}") from exc

        if resp.status_code == 401:
            raise BadAuth()
        if resp.status_code == 429:
            if attempt < max_retries:
                time.sleep(backoff)
                backoff *= 2
                continue
            raise RateLimited()
        if resp.status_code >= 400:
            raise ProviderError(resp.status_code, resp.text)

        try:
            return resp.json()
        except ValueError as exc:
            raise ProviderError(resp.status_code, f"invalid JSON: {exc}") from exc

    # Exhausted retries on 429/network without a definitive outcome.
    if last_exc is not None:
        raise ProviderError(0, f"network error after retries: {last_exc}") from last_exc
    raise RateLimited()
