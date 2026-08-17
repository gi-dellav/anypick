"""Obtainer protocols and caching wrappers.

An *obtainer* is the only piece of anypick that talks to a provider. It
translates the provider's raw payload into the normalized
:class:`~anypick.model.Model` / :class:`~anypick.model.BenchmarkScore` structs.

Caching is a wrapper, not a concern of the obtainer itself, so a
``CachedModelObtainer`` can wrap any ``ModelListObtainer``.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from typing import Any, Protocol, runtime_checkable

from .model import BenchmarkScore, Model


# ---------------------------------------------------------------------------
# Protocols
# ---------------------------------------------------------------------------


@runtime_checkable
class ModelListObtainer(Protocol):
    """Produces the full model catalog as normalized ``Model`` records."""

    def list_models(self, **opts: Any) -> list[Model]: ...


@runtime_checkable
class BenchmarkObtainer(Protocol):
    """Produces benchmark scores, optionally narrowed.

    Narrowing by ``source``/``task_type``/``benchmark_type`` is a *hint*: the
    picker re-filters on these fields regardless, so an obtainer that ignores
    the hints and returns everything is still correct.
    """

    def list_benchmarks(
        self,
        *,
        source: str | None = None,
        task_type: str | None = None,
        benchmark_type: str | None = None,
        **opts: Any,
    ) -> list[BenchmarkScore]: ...


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------


@runtime_checkable
class Cache(Protocol):
    """A tiny TTL cache. Implementations must be thread-safe enough for reads."""

    def get(self, key: str) -> Any: ...
    def set(self, key: str, value: Any, ttl: float | None = None) -> None: ...


def _hash_key(*parts: Any) -> str:
    """Stable hash over the parts used to build a cache key."""
    blob = json.dumps(parts, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class MemoryCache:
    """In-process TTL cache. Lost on restart."""

    def __init__(self) -> None:
        self._store: dict[str, tuple[Any, float | None]] = {}

    def get(self, key: str) -> Any:
        entry = self._store.get(key)
        if entry is None:
            return None
        value, expires = entry
        if expires is not None and time.time() >= expires:
            self._store.pop(key, None)
            return None
        return value

    def set(self, key: str, value: Any, ttl: float | None = None) -> None:
        expires = (time.time() + ttl) if ttl is not None else None
        self._store[key] = (value, expires)


class FileCache:
    """Filesystem TTL cache. Default location: ``~/.cache/anypick``."""

    def __init__(self, dir: str | None = None) -> None:
        self.dir = os.path.expanduser(dir or "~/.cache/anypick")
        os.makedirs(self.dir, exist_ok=True)

    def _path(self, key: str) -> str:
        return os.path.join(self.dir, f"{key}.json")

    def get(self, key: str) -> Any:
        path = self._path(key)
        if not os.path.exists(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as fh:
                envelope = json.load(fh)
        except (OSError, json.JSONDecodeError):
            return None
        expires = envelope.get("expires")
        if expires is not None and time.time() >= expires:
            try:
                os.remove(path)
            except OSError:
                pass
            return None
        return envelope.get("value")

    def set(self, key: str, value: Any, ttl: float | None = None) -> None:
        path = self._path(key)
        envelope = {
            "value": value,
            "expires": (time.time() + ttl) if ttl is not None else None,
        }
        try:
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(envelope, fh)
        except OSError:
            # Cache is best-effort; never fail a call because the disk is full.
            pass


# ---------------------------------------------------------------------------
# Cached wrappers
# ---------------------------------------------------------------------------


class CachedModelObtainer:
    """Wraps a :class:`ModelListObtainer` with a TTL cache."""

    def __init__(
        self,
        inner: ModelListObtainer,
        cache: Cache,
        ttl: float = 6 * 3600,
    ) -> None:
        self.inner = inner
        self.cache = cache
        self.ttl = ttl

    def list_models(self, **opts: Any) -> list[Model]:
        key = _hash_key("models", type(self.inner).__name__, opts)
        if opts.get("refresh"):
            cached = None
        else:
            cached = self.cache.get(key)
        if cached is not None:
            return [Model(**item) for item in cached]  # type: ignore[arg-type]
        value = self.inner.list_models(**{k: v for k, v in opts.items() if k != "refresh"})
        self.cache.set(key, [m.__dict__ for m in value], self.ttl)
        return value


class CachedBenchmarkObtainer:
    """Wraps a :class:`BenchmarkObtainer` with a TTL cache."""

    def __init__(
        self,
        inner: BenchmarkObtainer,
        cache: Cache,
        ttl: float = 24 * 3600,
    ) -> None:
        self.inner = inner
        self.cache = cache
        self.ttl = ttl

    def list_benchmarks(
        self,
        *,
        source: str | None = None,
        task_type: str | None = None,
        benchmark_type: str | None = None,
        **opts: Any,
    ) -> list[BenchmarkScore]:
        key = _hash_key(
            "benchmarks",
            type(self.inner).__name__,
            source,
            task_type,
            benchmark_type,
            opts,
        )
        if opts.get("refresh"):
            cached = None
        else:
            cached = self.cache.get(key)
        if cached is not None:
            return [BenchmarkScore(**item) for item in cached]  # type: ignore[arg-type]
        clean = {k: v for k, v in opts.items() if k != "refresh"}
        value = self.inner.list_benchmarks(
            source=source, task_type=task_type, benchmark_type=benchmark_type, **clean
        )
        self.cache.set(key, [s.__dict__ for s in value], self.ttl)
        return value
