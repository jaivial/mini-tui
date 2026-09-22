"""Rosetta LLM support for mini-swe-agent.

Rosetta is a local LLM gateway that exposes many upstream models behind a single
endpoint, speaking both the OpenAI `/v1/chat/completions` and the Anthropic
`/v1/messages` protocols.

Usage:

    mini -m rosetta/zai-glm/glm-4.6

The `rosetta/` prefix is stripped before the request is sent upstream, so the
model name that Rosetta receives is exactly the id it advertises on
`/v1/models` (e.g. `zai-glm/glm-4.6`).

Configuration (environment variables or `mini-extra config set KEY VALUE`):

    ROSETTA_API_BASE   default: http://127.0.0.1:9120/v1
    ROSETTA_API_KEY    default: rosetta-local

Because Rosetta fronts local/subscription backends, per-token costs are not
reported, so cost tracking defaults to "ignore_errors" for these models.
"""

import os
from typing import Any, Literal

from minisweagent.models.routing import ROSETTA_PREFIX, is_rosetta_model  # noqa: F401 (re-exported)
from minisweagent.models.openai_compat_model import OpenaiCompatModel, OpenaiCompatModelConfig, gateway_settings


DEFAULT_API_BASE = "http://127.0.0.1:9120/v1"
DEFAULT_API_KEY = "rosetta-local"



def strip_rosetta_prefix(model_name: str) -> str:
    """Remove the `rosetta/` routing prefix from a model name."""
    if is_rosetta_model(model_name):
        return model_name[len(ROSETTA_PREFIX) :]
    return model_name


class RosettaModelConfig(OpenaiCompatModelConfig):
    model_kwargs: dict[str, Any] = {}
    cost_tracking: Literal["default", "ignore_errors"] = os.getenv("MSWEA_COST_TRACKING", "ignore_errors")
    """Rosetta does not report per-token costs, so cost errors are ignored by default."""


class RosettaModel(OpenaiCompatModel):
    """Talks to the gateway's OpenAI-compatible `/chat/completions` directly (no litellm)."""

    def __init__(self, **kwargs):
        kwargs.setdefault("config_class", RosettaModelConfig)
        model_kwargs = dict(kwargs.get("model_kwargs") or {})
        kwargs.update(gateway_settings(model_kwargs, "ROSETTA_API_BASE", DEFAULT_API_BASE, "ROSETTA_API_KEY", DEFAULT_API_KEY))
        kwargs["model_kwargs"] = {k: v for k, v in model_kwargs.items() if k not in ("api_base", "api_key")}
        super().__init__(**kwargs)
        # The routing prefix is stripped: the gateway receives exactly the id it advertises.
        self.config.model_name = strip_rosetta_prefix(self.config.model_name)
