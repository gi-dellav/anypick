"""anypick — select an LLM across providers using capability, pricing and
benchmark filters, then pick the best.

See the project docs (``docs/``) for the full design.

Public API:
    anypick()                       one-shot selection
    pick_best()                     strategy decision over pre-fetched data
    ModelFilters, BenchmarkThreshold spec filters
    pred                            predicate combinators (pred.price_below(...), ...)
    Model, BenchmarkScore           normalized types
    ModelListObtainer, BenchmarkObtainer  extension protocols
    OpenRouterModelObtainer, OpenRouterBenchmarkObtainer  first provider impls
    VercelModelObtainer                          models-only provider (AI Gateway)
    CachedModelObtainer, CachedBenchmarkObtainer, Cache, FileCache, MemoryCache
    Selection, Strategy
    NoModelsFound, BadAuth, RateLimited, ProviderError
"""

from __future__ import annotations

from .api import anypick
from .errors import (
    AnypickError,
    BadAuth,
    NoModelsFound,
    ProviderError,
    RateLimited,
)
from .filter import (
    BenchmarkThreshold,
    ModelFilters,
    apply_filters,
    pred,
)
from .model import BenchmarkScore, Model, group_scores_by_model
from .obtainer import (
    BenchmarkObtainer,
    Cache,
    CachedBenchmarkObtainer,
    CachedModelObtainer,
    FileCache,
    MemoryCache,
    ModelListObtainer,
    NoopBenchmarkObtainer,
)
from .openrouter import (
    OpenRouterBenchmarkObtainer,
    OpenRouterModelObtainer,
)
from .pick import Selection, Strategy, pick_best
from .vercel import VercelModelObtainer

__all__ = [
    # one-shot
    "anypick",
    # lower-level
    "pick_best",
    "Selection",
    "Strategy",
    # filters
    "ModelFilters",
    "BenchmarkThreshold",
    "apply_filters",
    "pred",
    # types
    "Model",
    "BenchmarkScore",
    "group_scores_by_model",
    # obtainers
    "ModelListObtainer",
    "BenchmarkObtainer",
    "OpenRouterModelObtainer",
    "OpenRouterBenchmarkObtainer",
    "VercelModelObtainer",
    "NoopBenchmarkObtainer",
    "CachedModelObtainer",
    "CachedBenchmarkObtainer",
    "Cache",
    "FileCache",
    "MemoryCache",
    # errors
    "AnypickError",
    "NoModelsFound",
    "BadAuth",
    "RateLimited",
    "ProviderError",
]

__version__ = "0.1.0"
