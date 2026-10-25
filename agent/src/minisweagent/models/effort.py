"""Per-model reasoning effort from mini-tui (the Python runner's counterpart of Rust apply_effort)."""

import json
import os
from typing import Any


def apply_effort(model: str, effort: str, config: dict[str, Any]) -> None:
    if not effort or effort == "auto":
        return
    lower = model.lower()
    provider, _, bare = lower.partition("/")
    bare = bare or lower
    parts = bare.split("/")
    # Native Messages takes output_config; cli-proxy translates reasoning_effort upstream.
    claude = provider == "anthropic" or (provider == "opencode-go" and "claude" in bare)
    glm = provider in ("zai", "zhipu") or any(x.startswith("glm-") for x in parts)
    kimi = provider in ("kimi-coding", "moonshot") or "kimi-" in bare or any(x == "k3" or x.startswith("k3-") for x in parts)
    deepseek = provider == "deepseek" or any(x.startswith("deepseek-") for x in parts)
    xiaomi = provider == "xiaomi" or any(x.startswith("mimo-") for x in parts)
    kwargs = config.setdefault("model_kwargs", {})

    if claude:
        if effort in ("low", "medium", "high", "xhigh", "max"):
            kwargs["output_config"] = {"effort": effort}
        return
    if provider == "openrouter":
        kwargs["reasoning"] = {"enabled": False} if effort == "off" else {"effort": effort}
        return
    if provider == "ollama":
        kwargs["think"] = False if effort == "off" else effort
        return
    if glm or kimi or deepseek or xiaomi:
        mandatory = "glm-5.3" in bare or "k3" in bare or "k2.7-code" in bare
        if effort == "off":
            if not mandatory:
                kwargs["thinking"] = {"type": "disabled"}
                kwargs.pop("reasoning_effort", None)
        elif effort == "on":
            kwargs["thinking"] = {"type": "enabled"}
        elif effort in ("low", "medium", "high", "max") and not xiaomi:
            k3 = any(x == "k3" or x.startswith("k3-") for x in parts) or "kimi-k3" in bare
            # K3 always thinks and only accepts reasoning_effort; thinking.type belongs to K2.x.
            if not k3:
                kwargs["thinking"] = {"type": "enabled"}
            kwargs["reasoning_effort"] = effort
        return
    if effort in ("off", "minimal", "low", "medium", "high", "xhigh", "max"):
        kwargs["reasoning_effort"] = "none" if effort == "off" else effort


def apply_effort_from_env(model: str, config: dict[str, Any]) -> None:
    try:
        preferences = json.loads(os.getenv("MINI_AGENT_MODEL_EFFORTS", "{}"))
        effort = preferences.get(model)
        if isinstance(effort, str):
            apply_effort(model, effort, config)
    except (ValueError, TypeError, AttributeError):
        pass  # A hand-written malformed preference never prevents a run.
