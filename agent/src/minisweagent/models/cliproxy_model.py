"""cli-proxy-api support for mini-swe-agent.

cli-proxy-api is a local OpenAI-compatible gateway that multiplexes several
subscription CLIs (Claude Code, Codex, etc.) behind one `/v1/*` surface.

Usage:

    mini -m cliproxy/claude-sonnet-4-5-20250929
    mini -m cliproxy/gpt-5.6-sol

The `cliproxy/` prefix is stripped before the request is sent upstream, so the
model name the gateway receives is exactly the id it advertises on
`/v1/models`.

Configuration (environment variables or `mini-extra config set KEY VALUE`):

    CLIPROXY_API_BASE   default: http://127.0.0.1:8317/v1
    CLIPROXY_API_KEY    default: sk-cliproxy-local-2026

cli-proxy fronts subscription backends, so per-token costs are not reported and
cost tracking defaults to "ignore_errors" for these models.
"""

import os
from typing import Any, Literal

from minisweagent.models.litellm_model import LitellmModel, LitellmModelConfig

#: Prefix used to route a model name to cli-proxy-api.
CLIPROXY_PREFIX = "cliproxy/"

DEFAULT_API_BASE = "http://127.0.0.1:8317/v1"
DEFAULT_API_KEY = "sk-cliproxy-local-2026"


def is_cliproxy_model(model_name: str) -> bool:
    """Whether `model_name` should be served by cli-proxy-api."""
    return model_name.lower().startswith(CLIPROXY_PREFIX)


def strip_cliproxy_prefix(model_name: str) -> str:
    """Remove the `cliproxy/` routing prefix from a model name."""
    if is_cliproxy_model(model_name):
        return model_name[len(CLIPROXY_PREFIX) :]
    return model_name


class CliproxyModelConfig(LitellmModelConfig):
    model_kwargs: dict[str, Any] = {}
    cost_tracking: Literal["default", "ignore_errors"] = os.getenv("MSWEA_COST_TRACKING", "ignore_errors")
    """cli-proxy does not report per-token costs, so cost errors are ignored by default."""


class CliproxyModel(LitellmModel):
    """Talks to a cli-proxy-api gateway through litellm's OpenAI-compatible provider."""

    def __init__(self, **kwargs):
        kwargs.setdefault("config_class", CliproxyModelConfig)
        super().__init__(**kwargs)

        upstream_name = strip_cliproxy_prefix(self.config.model_name)
        self.config.model_name = f"openai/{upstream_name}"

        model_kwargs = dict(self.config.model_kwargs)
        model_kwargs.setdefault("custom_llm_provider", "openai")
        model_kwargs.setdefault("api_base", os.getenv("CLIPROXY_API_BASE", DEFAULT_API_BASE).rstrip("/"))
        model_kwargs.setdefault("api_key", os.getenv("CLIPROXY_API_KEY", DEFAULT_API_KEY))
        # cli-proxy backends vary in which sampling params they accept.
        model_kwargs.setdefault("drop_params", True)
        self.config.model_kwargs = model_kwargs
