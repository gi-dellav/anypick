"""anypick errors."""

from __future__ import annotations


class AnypickError(Exception):
    """Base class for anypick errors."""


class NoModelsFound(AnypickError):
    """Raised when filtering empties the candidate set.

    Attributes:
        survivors_by_clause: ordered mapping of clause name -> count of models
            surviving *that* clause (cumulative, in application order). The last
            entry being 0 pinpoints the filter that emptied the set.
    """

    def __init__(self, survivors_by_clause: dict[str, int]):
        self.survivors_by_clause = survivors_by_clause
        clauses = ", ".join(f"{k}={v}" for k, v in survivors_by_clause.items())
        super().__init__(f"No models survived the filters ({clauses})")


class ProviderError(AnypickError):
    """A provider returned a non-2xx response (other than 401/429)."""

    def __init__(self, status: int, body: str):
        self.status = status
        self.body = body
        super().__init__(f"Provider error {status}: {body[:200]}")


class BadAuth(AnypickError):
    """A keyed endpoint returned 401."""

    def __init__(self, message: str = "Missing or invalid API key (401)."):
        super().__init__(message)


class RateLimited(AnypickError):
    """A keyed endpoint returned 429 after backoff was exhausted."""

    def __init__(self, message: str = "Rate limit exceeded (429)."):
        super().__init__(message)
