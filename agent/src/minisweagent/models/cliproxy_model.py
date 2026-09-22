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

from minisweagent.models.routing import CLIPROXY_PREFIX, is_cliproxy_model  # noqa: F401 (re-exported)
from minisweagent.models.openai_compat_model import OpenaiCompatModel, OpenaiCompatModelConfig, gateway_settings


DEFAULT_API_BASE = "http://127.0.0.1:8317/v1"
DEFAULT_API_KEY = "sk-cliproxy-local-2026"



def strip_cliproxy_prefix(model_name: str) -> str:
    """Remove the `cliproxy/` routing prefix from a model name."""
    if is_cliproxy_model(model_name):
        return model_name[len(CLIPROXY_PREFIX) :]
    return model_name


class CliproxyModelConfig(OpenaiCompatModelConfig):
    model_kwargs: dict[str, Any] = {}
    cost_tracking: Literal["default", "ignore_errors"] = os.getenv("MSWEA_COST_TRACKING", "ignore_errors")
    """cli-proxy does not report per-token costs, so cost errors are ignored by default."""


class CliproxyModel(OpenaiCompatModel):
    """Talks to the gateway's OpenAI-compatible `/chat/completions` directly (no litellm)."""

    def __init__(self, **kwargs):
        kwargs.setdefault("config_class", CliproxyModelConfig)
        model_kwargs = dict(kwargs.get("model_kwargs") or {})
        kwargs.update(gateway_settings(model_kwargs, "CLIPROXY_API_BASE", DEFAULT_API_BASE, "CLIPROXY_API_KEY", DEFAULT_API_KEY))
        kwargs["model_kwargs"] = {k: v for k, v in model_kwargs.items() if k not in ("api_base", "api_key")}
        super().__init__(**kwargs)
        # The routing prefix is stripped: the gateway receives exactly the id it advertises.
        self.config.model_name = strip_cliproxy_prefix(self.config.model_name)
