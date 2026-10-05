"""Connected providers (``~/.config/mini-tui/providers.json``): the model name alone picks its
credentials, as ``modelEnv`` does for mini-tui's own launches. Mirrors agent-rs ``models/connections.rs``."""

import json
import os
from pathlib import Path


def _connections_path() -> Path:
    return Path(os.getenv("MINITUI_CONNECTIONS_PATH") or Path.home() / ".config" / "mini-tui" / "providers.json")


def model_env(model: str, connections: list) -> dict[str, str]:
    """Environment a saved connection contributes for ``model`` (empty when none serves it)."""
    for c in connections if isinstance(connections, list) else []:
        prefix = f"{c.get('prefix', '')}/"
        if not model.startswith(prefix) or model[len(prefix) :] not in (c.get("models") or []) or not c.get("key"):
            continue
        if c.get("route") == "native":
            env = {c.get("keyEnv", ""): c["key"], **(c.get("extraEnv") or {})}
            return {k: v for k, v in env.items() if k}
        key, base = c["key"], c.get("baseUrl", "")
        return {"OPENAI_API_KEY": key, "OPENAI_API_BASE": base, "MSWEA_OPENAI_API_KEY": key, "MSWEA_OPENAI_API_BASE": base}
    return {}


def apply(model: str) -> None:
    """Export the connection's credentials for ``model``; variables already set win."""
    try:
        connections = json.loads(_connections_path().read_text())
    except (OSError, ValueError):
        return
    for key, value in model_env(model, connections).items():
        if not os.getenv(key):
            os.environ[key] = value
