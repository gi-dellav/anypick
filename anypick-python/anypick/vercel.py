"""Vercel AI Gateway provider implementation (models only).

See docs/providers/vercel.md for the endpoint contract, response shape, and
mapping rules.

* :class:`VercelModelObtainer` — ``GET /v1/models`` (public; Bearer key optional).

The Vercel AI Gateway exposes **no benchmark feed**, so there is no
``VercelBenchmarkObtainer`` here. Wiring the gateway into :func:`anypick` pairs
this obtainer with :class:`~anypick.obtainer.NoopBenchmarkObtainer`; only
price-only strategies (``cheapest``) are meaningful against it.
"""

from __future__ import annotations

import os
from typing import Any

from ._http import _f, _get, _request
from .model import Model

DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v1"

# Capability tag -> input modality it implies. Vercel's ``tags`` array is the
# only capability signal on the list-models payload; language models accept
# ``text`` by default. See docs/providers/vercel.md §"Capability derivation".
_TAG_TO_INPUT_MODALITY = {
    "vision": "image",
    "file-input": "file",
    "audio-input": "audio",
}

# ``type`` -> default output modality.
_TYPE_TO_OUTPUT_MODALITY = {
    "language": "text",
    "image": "image",
    "video": "video",
}


class VercelModelObtainer:
    """List models from the Vercel AI Gateway ``/v1/models`` endpoint.

    The endpoint is public (no auth) but accepts an optional
    ``Authorization: Bearer <key>`` (an AI Gateway API key), which raises the
    unauthenticated rate ceiling. Pass ``api_key`` or set
    ``VERCEL_AI_GATEWAY_API_KEY``.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        api_key: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or os.environ.get("VERCEL_AI_GATEWAY_API_KEY")
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
    tags = list(_get(item, "tags", []) or [])
    model_type = item.get("type", "language")

    # Input modalities: language models always accept text; tags add the rest.
    input_modalities: list[str] = []
    if model_type in ("language", "embedding", "reranking", "image", "video"):
        input_modalities.append("text")
    for tag in tags:
        modality = _TAG_TO_INPUT_MODALITY.get(tag)
        if modality and modality not in input_modalities:
            input_modalities.append(modality)

    # Output modalities: derived from ``type``. Language models emit text;
    # image/video models emit their respective modality. Embedding/reranking
    # models emit vectors (not representable as a chat modality) -> [].
    output_modality = _TYPE_TO_OUTPUT_MODALITY.get(model_type)
    output_modalities: list[str] = [output_modality] if output_modality else []

    return Model(
        id=item.get("id", ""),
        name=item.get("name", item.get("id", "")),
        context_length=int(_get(item, "context_window", 0) or 0),
        input_modalities=input_modalities,
        output_modalities=output_modalities,
        prompt_price=_f(pricing.get("input")),
        completion_price=_f(pricing.get("output")),
        cache_read_price=_f(pricing.get("input_cache_read")),
        supports_tools="tool-use" in tags,
        supports_reasoning="reasoning" in tags,
        # Vercel's list-models payload has no structured-output signal; this
        # stays False (unknown) until the per-model endpoints endpoint is used.
        supports_structured_outputs=False,
        raw=item,
    )
