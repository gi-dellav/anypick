"""Shared HTTP + parsing helpers used by provider implementations.

Kept in a private module so provider modules (``openrouter``, ``vercel``, …)
don't re-implement the same auth/rate-limit/JSON dance and don't reach into
each other's private functions.

* :func:`_f`    — lenient ``float`` parse for pricing/score strings.
* :func:`_get`  — dict get that tolerates non-dict values.
* :func:`_request` — ``requests`` wrapper that maps 401/429/non-2xx to
  :class:`~anypick.errors` types, with optional exponential backoff on 429 /
  network errors.
"""

from __future__ import annotations

import time
from typing import Any

import requests

from .errors import BadAuth, ProviderError, RateLimited


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


def _request(
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    params: dict[str, str] | None = None,
    timeout: float = 30.0,
    max_retries: int = 0,
) -> dict[str, Any]:
    """Perform an HTTP request with auth/rate-limit error mapping + backoff.

    ``max_retries`` retries on 429 / network errors with exponential backoff
    (0.5s, 1s, 2s, …). 401 → :class:`BadAuth` immediately; other non-2xx →
    :class:`ProviderError`. Returns the parsed JSON body.
    """
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
