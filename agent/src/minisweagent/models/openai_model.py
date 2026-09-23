"""OpenAI API support for mini-swe-agent \u2014 direct, no litellm.

OpenAI hosts its models behind an OpenAI-compatible `/chat/completions` surface at
`https://api.openai.com`, which `OpenaiCompatModel` calls directly. Some ids
(e.g. `openai/gpt-6-astra`) reject function tools on `/chat/completions` and are served
through the Responses API (`ResponsesCompatModel`) automatically. Cost tracking comes
from `models/prices.py` (ids without a price row report cost 0.0).

Usage:

    mini -m openai/gpt-5.4
    mini -m openai/gpt-5.4-mini
    mini -m openai/gpt-4o
    mini -m openai/gpt-6-astra          # Responses API (see below)

Configuration (environment variables or `mini-extra config set KEY VALUE`):

    MSWEA_OPENAI_API_KEY    default: (falls back to OPENAI_API_KEY)
    MSWEA_OPENAI_API_BASE   default: (falls back to OPENAI_API_BASE)
    OPENAI_API_KEY          default: (empty)
    OPENAI_API_BASE         default: https://api.openai.com/v1

The `MSWEA_`-prefixed variables take precedence. They exist because many other
tools export `OPENAI_API_KEY`/`OPENAI_API_BASE` for their own OpenAI-compatible
gateway (the Rosetta/cli-proxy proxies do exactly this), which would otherwise
shadow the key you configured for `mini`. Set the `MSWEA_` pair to keep the two
apart:

    mini-extra config set MSWEA_OPENAI_API_KEY sk-your-key

`OPENAI_API_BASE` also turns this into the generic OpenAI-compatible client for any
endpoint re-serving OpenAI-style ids (local models, proxies).
"""

import os
import re
from typing import Any, Literal

from minisweagent.models.errors import ProviderError
from minisweagent.models.openai_compat_model import OpenaiCompatModel, OpenaiCompatModelConfig
from minisweagent.models.responses_compat_model import ResponsesCompatModel
from minisweagent.models.routing import (  # noqa: F401 (re-exported)
    OPENAI_PREFIX,
    is_openai_model,
    openai_needs_responses_api,
)

DEFAULT_API_BASE = "https://api.openai.com/v1"
DEFAULT_API_KEY = ""


def strip_openai_prefix(model_name: str) -> str:
    """Remove the `openai/` routing prefix from a model name."""
    if is_openai_model(model_name):
        return model_name[len(OPENAI_PREFIX) :]
    return model_name


needs_responses_api = openai_needs_responses_api


#: OpenAI rejects a configured `temperature` on some reasoning ids (e.g. "Only the default
#: (1) value is supported" / "'temperature' is not supported with this model"). Strip it
#: and retry once \u2014 same fallback as the litellm path had.
_TEMPERATURE_ERROR_RE = re.compile(r"temperature.*(?:not supported|does not support|unsupported)", re.IGNORECASE)


def _is_temperature_error(exception: Exception) -> bool:
    return isinstance(exception, ProviderError) and bool(_TEMPERATURE_ERROR_RE.search(str(exception)))


def _openai_model_kwargs(model_kwargs: dict[str, Any]) -> dict[str, Any]:
    """Fill in the OpenAI api_base/api_key defaults without overriding explicit values."""
    model_kwargs = dict(model_kwargs or {})
    api_base = os.getenv("MSWEA_OPENAI_API_BASE") or os.getenv("OPENAI_API_BASE", DEFAULT_API_BASE)
    model_kwargs.setdefault("api_base", api_base.rstrip("/"))
    api_key = os.getenv("MSWEA_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY", DEFAULT_API_KEY)
    if api_key:
        model_kwargs.setdefault("api_key", api_key)
    model_kwargs.setdefault("drop_params", True)  # kept for config compatibility
    return model_kwargs


def _openai_wire_name(model_name: str) -> str:
    """The wire gets the bare id (litellm used the prefix to pick its provider)."""
    return strip_openai_prefix(model_name)


class _TemperatureFallbackMixin:
    """Retry a rejected `temperature` without it, and remember the rejection for later turns."""

    def _query(self, messages, **kwargs):
        try:
            return super()._query(messages, **kwargs)
        except ProviderError as e:
            if not _is_temperature_error(e) or "temperature" not in self.config.model_kwargs:
                raise
            self.config.model_kwargs.pop("temperature", None)
            return super()._query(messages, **kwargs)


class OpenaiModelConfig(OpenaiCompatModelConfig):
    model_kwargs: dict[str, Any] = {}
    cost_tracking: Literal["default", "ignore_errors"] = os.getenv("MSWEA_COST_TRACKING", "ignore_errors")
    """OpenAI ships new model ids faster than price tables track, and an unpriced id
    would otherwise abort a run as soon as the first response comes back. Set
    `cost_tracking: default` (or `export MSWEA_COST_TRACKING=default`) if you want
    unpriced ids to be fatal."""


class OpenaiModel(_TemperatureFallbackMixin, OpenaiCompatModel):
    """Talks to the OpenAI API (or any compatible endpoint) directly."""

    _price_provider = "openai"

    def _wire_model_name(self) -> str:
        return _openai_wire_name(self.config.model_name)

    def __init__(self, **kwargs):
        kwargs.setdefault("config_class", OpenaiModelConfig)
        model_kwargs = _openai_model_kwargs(dict(kwargs.get("model_kwargs") or {}))
        kwargs["api_base"] = str(model_kwargs.pop("api_base", DEFAULT_API_BASE)).rstrip("/")
        api_key = model_kwargs.pop("api_key", DEFAULT_API_KEY)
        if api_key:
            kwargs["api_key"] = api_key
        kwargs["model_kwargs"] = model_kwargs
        super().__init__(**kwargs)


class OpenaiResponseModelConfig(OpenaiModelConfig):
    pass


class OpenaiResponseModel(_TemperatureFallbackMixin, ResponsesCompatModel):
    """Talks to OpenAI through the Responses API, directly.

    The Responses API is required for models that reject function tools on the chat
    completions endpoint (e.g. `openai/gpt-6-astra`).
    """

    _price_provider = "openai"

    def _wire_model_name(self) -> str:
        return _openai_wire_name(self.config.model_name)

    def __init__(self, **kwargs):
        kwargs.setdefault("config_class", OpenaiResponseModelConfig)
        model_kwargs = _openai_model_kwargs(dict(kwargs.get("model_kwargs") or {}))
        kwargs["api_base"] = str(model_kwargs.pop("api_base", DEFAULT_API_BASE)).rstrip("/")
        api_key = model_kwargs.pop("api_key", DEFAULT_API_KEY)
        if api_key:
            kwargs["api_key"] = api_key
        kwargs["model_kwargs"] = model_kwargs
        super().__init__(**kwargs)
