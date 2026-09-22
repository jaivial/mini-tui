"""Xiaomi MiMo API support for mini-swe-agent.

Xiaomi serves its MiMo models behind an OpenAI-compatible `/chat/completions`
surface at `https://token-plan-sgp.xiaomimimo.com` (the MiMo Token Plan endpoint).

Usage:

    mini -m xiaomi/mimo-v2.6-pro
    mini -m xiaomi/mimo-v2.6-flash
    mini -m mimo-v2.6-pro              # bare MiMo ids work too

The `xiaomi/` prefix is stripped before the request is sent upstream, so the model
name Xiaomi receives is exactly the id it advertises on `/v1/models`
(e.g. `mimo-v2.6-pro`).

Configuration (environment variables or `mini-extra config set KEY VALUE`):

    XIAOMI_API_BASE   default: https://token-plan-sgp.xiaomimimo.com/v1
    XIAOMI_API_KEY    default: (empty)

Run `mini-extra xiaomi-models` to list the ids your key accepts.
"""

import os
from typing import Any, Literal

from minisweagent.models.routing import XIAOMI_PREFIX, is_xiaomi_model  # noqa: F401 (re-exported)
from minisweagent.models.openai_compat_model import OpenaiCompatModel, OpenaiCompatModelConfig, gateway_settings


DEFAULT_API_BASE = "https://token-plan-sgp.xiaomimimo.com/v1"
DEFAULT_API_KEY = ""
"""An unset key fails on the first call with a clear 401 message."""



def strip_xiaomi_prefix(model_name: str) -> str:
    """Remove the `xiaomi/` routing prefix from a model name."""
    if model_name.lower().startswith(XIAOMI_PREFIX):
        return model_name[len(XIAOMI_PREFIX) :]
    return model_name


class XiaomiModelConfig(OpenaiCompatModelConfig):
    model_kwargs: dict[str, Any] = {}
    cost_tracking: Literal["default", "ignore_errors"] = os.getenv("MSWEA_COST_TRACKING", "ignore_errors")
    """The token-plan endpoint reports no per-token prices, so cost errors are ignored by default."""


class XiaomiModel(OpenaiCompatModel):
    """Talks to the gateway's OpenAI-compatible `/chat/completions` directly (no litellm)."""

    def __init__(self, **kwargs):
        kwargs.setdefault("config_class", XiaomiModelConfig)
        model_kwargs = dict(kwargs.get("model_kwargs") or {})
        kwargs.update(gateway_settings(model_kwargs, "XIAOMI_API_BASE", DEFAULT_API_BASE, "XIAOMI_API_KEY", DEFAULT_API_KEY))
        kwargs["model_kwargs"] = {k: v for k, v in model_kwargs.items() if k not in ("api_base", "api_key")}
        super().__init__(**kwargs)
        # The routing prefix is stripped: the gateway receives exactly the id it advertises.
        self.config.model_name = strip_xiaomi_prefix(self.config.model_name)
