"""Shared configuration construction for mini's CLI and embedded runners."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from pathlib import Path

from minisweagent.config import get_config_from_spec
from minisweagent.utils.serialize import UNSET, recursive_merge


def build_run_config(
    config_spec: Sequence[str | Path],
    *,
    task: str | None = None,
    model_name: str | None = None,
    model_class: str | None = None,
    agent_class: str | None = None,
    environment_class: str | None = None,
    yolo: bool = False,
    cost_limit: float | None = None,
    output: Path | None = None,
    exit_immediately: bool = False,
    config_loader: Callable[[str | Path], dict] = get_config_from_spec,
) -> dict:
    """Merge YAML/key-value specs with command-line overrides.

    Command-line values are applied last and ``UNSET`` values are ignored by
    :func:`recursive_merge`, so the embedded runner and Typer CLI have exactly
    the same precedence rules. ``config_loader`` is injectable for the CLI's
    unit tests and for embedders with a custom config source.
    """
    configs = [config_loader(spec) for spec in config_spec]
    configs.append(
        {
            "run": {"task": task or UNSET},
            "agent": {
                "agent_class": agent_class or UNSET,
                "mode": "yolo" if yolo else UNSET,
                "cost_limit": cost_limit if cost_limit is not None else UNSET,
                "confirm_exit": False if exit_immediately else UNSET,
                "output_path": output or UNSET,
            },
            "model": {
                "model_class": model_class or UNSET,
                "model_name": model_name or UNSET,
            },
            "environment": {"environment_class": environment_class or UNSET},
        }
    )
    return recursive_merge(*configs)
