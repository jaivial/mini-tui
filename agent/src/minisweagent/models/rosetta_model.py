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

from minisweagent.models.litellm_model import LitellmModel, LitellmModelConfig

#: Prefix used to route a model name to Rosetta.
ROSETTA_PREFIX = "rosetta/"

DEFAULT_API_BASE = "http://127.0.0.1:9120/v1"
DEFAULT_API_KEY = "rosetta-local"


def is_rosetta_model(model_name: str) -> bool:
    """Whether `model_name` should be served by Rosetta."""
    return model_name.lower().startswith(ROSETTA_PREFIX)


def strip_rosetta_prefix(model_name: str) -> str:
    """Remove the `rosetta/` routing prefix from a model name."""
    if is_rosetta_model(model_name):
        return model_name[len(ROSETTA_PREFIX) :]
    return model_name


class RosettaModelConfig(LitellmModelConfig):
    model_kwargs: dict[str, Any] = {}
    cost_tracking: Literal["default", "ignore_errors"] = os.getenv("MSWEA_COST_TRACKING", "ignore_errors")
    """Rosetta does not report per-token costs, so cost errors are ignored by default."""


class RosettaModel(LitellmModel):
    """Talks to a Rosetta gateway through litellm's OpenAI-compatible provider."""

    def __init__(self, **kwargs):
        kwargs.setdefault("config_class", RosettaModelConfig)
        super().__init__(**kwargs)

        # Route through litellm's openai provider, pointed at the Rosetta gateway.
        upstream_name = strip_rosetta_prefix(self.config.model_name)
        self.config.model_name = f"openai/{upstream_name}"

        model_kwargs = dict(self.config.model_kwargs)
        model_kwargs.setdefault("custom_llm_provider", "openai")
        model_kwargs.setdefault("api_base", os.getenv("ROSETTA_API_BASE", DEFAULT_API_BASE).rstrip("/"))
        model_kwargs.setdefault("api_key", os.getenv("ROSETTA_API_KEY", DEFAULT_API_KEY))
        # Rosetta backends vary in which sampling params they accept.
        model_kwargs.setdefault("drop_params", True)
        self.config.model_kwargs = model_kwargs
