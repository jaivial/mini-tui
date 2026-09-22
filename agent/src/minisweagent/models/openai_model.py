"""OpenAI API support for mini-swe-agent.

OpenAI hosts its models behind an OpenAI-compatible `/chat/completions`
surface at `https://api.openai.com`, which litellm supports through the
native `openai/` provider.

Usage:

    mini -m openai/gpt-5.4
    mini -m openai/gpt-5.4-mini
    mini -m openai/gpt-4o
    mini -m openai/gpt-6-astra          # Responses API (see below)

The `openai/` prefix is *not* stripped: it is exactly how litellm identifies
the OpenAI provider, which gives us working cost tracking for every id that
litellm knows the prices of (ids it does not know are reported as cost 0.0).

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

Some ids (e.g. `openai/gpt-6-astra`) reject function tools on
`/chat/completions` and are served through the Responses API automatically.
"""

import os
import re
from typing import Any, Literal

import litellm

from minisweagent.models.litellm_model import LitellmModel, LitellmModelConfig
from minisweagent.models.litellm_response_model import LitellmResponseModel

#: Prefix used to route a model name to the OpenAI API.
OPENAI_PREFIX = "openai/"

DEFAULT_API_BASE = "https://api.openai.com/v1"
DEFAULT_API_KEY = ""
"""litellm picks up `OPENAI_API_KEY` when no explicit key is set."""


def is_openai_model(model_name: str) -> bool:
    """Whether `model_name` should be served by the OpenAI API."""
    return model_name.lower().startswith(OPENAI_PREFIX)


def strip_openai_prefix(model_name: str) -> str:
    """Remove the `openai/` routing prefix from a model name."""
    if is_openai_model(model_name):
        return model_name[len(OPENAI_PREFIX) :]
    return model_name


#: OpenAI ids that reject function tools on `/chat/completions` and therefore need the
#: Responses API, e.g. `gpt-6-astra`:
#: "Function tools with reasoning_effort are not supported ... use /v1/responses".
_RESPONSES_ONLY_RE = re.compile(r"^gpt-6(?:$|[.-])")


def needs_responses_api(model_name: str) -> bool:
    """Whether `model_name` can only run the agent through the OpenAI Responses API."""
    return bool(_RESPONSES_ONLY_RE.match(strip_openai_prefix(model_name)))


#: OpenAI rejects a configured `temperature` on some reasoning ids (e.g. "Only the default
#: (1) value is supported" / "'temperature' is not supported with this model"). litellm's
#: metadata does not know this, so `drop_params` cannot remove it; strip it and retry once.
_TEMPERATURE_ERROR_RE = re.compile(r"temperature.*(?:not supported|does not support|unsupported)", re.IGNORECASE)


def _is_temperature_error(exception: Exception) -> bool:
    return isinstance(exception, litellm.exceptions.BadRequestError) and bool(
        _TEMPERATURE_ERROR_RE.search(str(exception))
    )


def _openai_model_kwargs(model_kwargs: dict[str, Any]) -> dict[str, Any]:
    """Fill in the OpenAI api_base/api_key/drop_params defaults without overriding explicit values."""
    model_kwargs = dict(model_kwargs or {})
    api_base = os.getenv("MSWEA_OPENAI_API_BASE") or os.getenv("OPENAI_API_BASE", DEFAULT_API_BASE)
    model_kwargs.setdefault("api_base", api_base.rstrip("/"))
    api_key = os.getenv("MSWEA_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY", DEFAULT_API_KEY)
    if api_key:
        # Otherwise leave it to litellm to resolve OPENAI_API_KEY and complain loudly.
        model_kwargs.setdefault("api_key", api_key)
    # OpenAI's reasoning models (o-series, some gpt-5/gpt-6 ids) reject sampling parameters
    # such as `temperature`; drop them instead of failing the whole run.
    model_kwargs.setdefault("drop_params", True)
    return model_kwargs


class _TemperatureFallbackMixin:
    """Retry a rejected `temperature` without it, and remember the rejection for later turns."""

    def _query(self, messages: list[dict[str, str]], **kwargs):
        try:
            return super()._query(messages, **kwargs)
        except litellm.exceptions.BadRequestError as e:
            if not _is_temperature_error(e) or "temperature" not in self.config.model_kwargs:
                raise
            self.config.model_kwargs.pop("temperature", None)
            return super()._query(messages, **kwargs)


class OpenaiModelConfig(LitellmModelConfig):
    model_kwargs: dict[str, Any] = {}
    cost_tracking: Literal["default", "ignore_errors"] = os.getenv("MSWEA_COST_TRACKING", "ignore_errors")
    """OpenAI ships new model ids faster than litellm maps their prices, and an unmapped id
    would otherwise abort a run as soon as the first response comes back. Set `cost_tracking:
    default` (or `export MSWEA_COST_TRACKING=default`) if you want unmapped ids to be fatal."""


class OpenaiModel(_TemperatureFallbackMixin, LitellmModel):
    """Talks to the OpenAI API through litellm's native `openai` provider."""

    def __init__(self, **kwargs):
        kwargs.setdefault("config_class", OpenaiModelConfig)
        super().__init__(**kwargs)

        # The `openai/` prefix is kept: it is how litellm selects the provider and its prices.
        self.config.model_kwargs = _openai_model_kwargs(self.config.model_kwargs)


class OpenaiResponseModelConfig(LitellmModelConfig):
    model_kwargs: dict[str, Any] = {}
    cost_tracking: Literal["default", "ignore_errors"] = os.getenv("MSWEA_COST_TRACKING", "ignore_errors")
    """Same reasoning as `OpenaiModelConfig`: unmapped ids report a cost of 0.0 instead of aborting."""


class OpenaiResponseModel(_TemperatureFallbackMixin, LitellmResponseModel):
    """Talks to OpenAI through litellm's `openai` provider using the Responses API.

    The Responses API is required for models that reject function tools on the chat
    completions endpoint (e.g. `openai/gpt-6-astra`). The `openai/` prefix is kept.
    """

    def __init__(self, **kwargs):
        kwargs.setdefault("config_class", OpenaiResponseModelConfig)
        super().__init__(**kwargs)
        self.config.model_kwargs = _openai_model_kwargs(self.config.model_kwargs)
