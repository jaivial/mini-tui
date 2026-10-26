"""Per-provider context windows and output caps shipped by mini-tui.

Resolution happens when each model is constructed, including mid-session model switches. Explicit
model config wins over ``MSWEA_*`` overrides, which win over the shipped catalog. Unknown or local
models intentionally keep the agent's existing defaults.
"""

import json
import os
from pathlib import Path
from typing import Any


def _catalog_paths():
    if home := os.getenv("MINITUI_HOME"):
        yield Path(home) / "config" / "model-limits.json"
    # Source checkout fallback. Installed Python-only distributions simply have no shared catalog.
    yield Path(__file__).resolve().parents[4] / "config" / "model-limits.json"


def model_limits(model_name: str) -> dict[str, int] | None:
    """Return the row for a fully-qualified id (or an unqualified native-provider alias)."""
    lowered = model_name.lower()
    candidates = [lowered]
    if "/" not in lowered:
        if lowered.startswith("deepseek"):
            candidates.append(f"deepseek/{lowered}")
        elif lowered.startswith("mimo"):
            candidates.append(f"xiaomi/{lowered}")
        elif any(part in lowered for part in ("claude", "sonnet", "opus")):
            candidates.append(f"anthropic/{lowered}")
    for path in _catalog_paths():
        try:
            models = json.loads(path.read_text())["models"]
        except (OSError, ValueError, KeyError, TypeError):
            continue
        for candidate in candidates:
            row = models.get(candidate)
            if not isinstance(row, dict):
                continue
            try:
                window = int(row["contextWindow"])
                output = int(row["maxOutputTokens"])
            except (KeyError, TypeError, ValueError):
                continue
            if window > 0 and output > 0:
                return {"context_window": window, "max_output_tokens": output}
    return None


def _positive_env(name: str) -> int | None:
    try:
        value = int(os.getenv(name, "0"))
    except ValueError:
        return None
    return value if value > 0 else None


def apply_model_limits(config: Any, *, explicit_max_tokens: bool = False) -> None:
    """Apply catalog/env defaults to an OpenaiCompatModelConfig-compatible object."""
    limits = model_limits(str(getattr(config, "model_name", "") or ""))
    if getattr(config, "context_window", 0) <= 0:
        if window := _positive_env("MSWEA_CONTEXT_WINDOW") or (limits or {}).get("context_window"):
            config.context_window = window
    if explicit_max_tokens:
        return
    if output := _positive_env("MSWEA_MAX_TOKENS") or (limits or {}).get("max_output_tokens"):
        if hasattr(config, "max_tokens"):
            config.max_tokens = output
        else:
            config.model_kwargs.setdefault("max_tokens", output)
