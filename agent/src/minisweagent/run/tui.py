"""Lightweight embedded entry point used by mini-tui.

This runner deliberately does not import Typer, Rich, or the interactive agent
for the normal yolo path. mini-tui already owns terminal presentation; the agent
only needs the same configuration merge, model loop, trajectory journal, and
control-file protocol as ``mini``.
"""

from __future__ import annotations

import gc
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn

from minisweagent import global_config_dir
from minisweagent.run.config import build_run_config

DEFAULT_CONFIG_FILE = Path(os.getenv("MSWEA_MINI_CONFIG_PATH", Path(__file__).parent.parent / "config" / "mini.yaml"))
DEFAULT_OUTPUT_FILE = global_config_dir / "last_mini_run.traj.json"

USAGE = """mini-swe-agent-tui - internal runner for mini-tui

Usage:
  mini-swe-agent-tui -y --exit-immediately -o <trajectory> [-m <model>]
                    [-c <config>]... -t <task> [--resume <trajectory>]
"""


class UsageError(ValueError):
    """Invalid arguments passed by the embedding TUI."""


@dataclass
class Options:
    task: str | None = None
    model_name: str | None = None
    model_class: str | None = None
    agent_class: str | None = None
    environment_class: str | None = None
    resume: Path | None = None
    output: Path | None = None
    cost_limit: float | None = None
    configs: list[str] | None = None
    yolo: bool = False
    exit_immediately: bool = False


_VALUE_OPTIONS = {
    "-t": "task",
    "--task": "task",
    "-m": "model_name",
    "--model": "model_name",
    "--model-class": "model_class",
    "--agent-class": "agent_class",
    "--environment-class": "environment_class",
    "-c": "config",
    "--config": "config",
    "-o": "output",
    "--output": "output",
    "--resume": "resume",
    "-l": "cost_limit",
    "--cost-limit": "cost_limit",
}
_PATH_OPTIONS = {"output", "resume"}
_FLOAT_OPTIONS = {"cost_limit"}


def _missing(name: str) -> NoReturn:
    raise UsageError(f"{name} requires a value\n\n{USAGE}")


def _parse_args(argv: list[str]) -> Options:
    options = Options(configs=[])
    index = 0
    positional: list[str] = []
    while index < len(argv):
        arg = argv[index]
        if arg in ("-y", "--yolo"):
            options.yolo = True
            index += 1
            continue
        if arg == "--exit-immediately":
            options.exit_immediately = True
            index += 1
            continue
        if arg in ("-h", "--help"):
            print(USAGE)
            raise SystemExit(0)

        name, separator, inline_value = arg.partition("=")
        destination = _VALUE_OPTIONS.get(name)
        if destination is None:
            if arg.startswith("-") and arg != "-":
                raise UsageError(f"unknown option: {arg}\n\n{USAGE}")
            positional.append(arg)
            index += 1
            continue
        if separator:
            value = inline_value
            index += 1
        else:
            index += 1
            if index >= len(argv):
                _missing(name)
            value = argv[index]
            index += 1
        if not value:
            _missing(name)
        if destination == "config":
            options.configs.append(value)
        elif destination in _PATH_OPTIONS:
            setattr(options, destination, Path(value).expanduser())
        elif destination in _FLOAT_OPTIONS:
            try:
                setattr(options, destination, float(value))
            except ValueError as error:
                raise UsageError(f"invalid number for {name}: {value}") from error
        else:
            setattr(options, destination, value)

    if positional:
        options.task = " ".join(positional)
    if not options.task:
        raise UsageError("a task is required\n\n{USAGE}")
    if not options.yolo:
        raise UsageError("mini-swe-agent-tui only supports yolo runs (-y)")
    if not options.output:
        options.output = DEFAULT_OUTPUT_FILE
    if not options.configs:
        options.configs = [str(DEFAULT_CONFIG_FILE)]
    return options


def _run_cli_main(argv: list[str] | None = None) -> object:
    """Run one yolo agent and return the agent instance."""
    options = _parse_args(list(sys.argv[1:] if argv is None else argv))
    config = build_run_config(
        options.configs or [],
        task=options.task,
        model_name=options.model_name,
        model_class=options.model_class,
        agent_class=options.agent_class,
        environment_class=options.environment_class,
        yolo=options.yolo,
        cost_limit=options.cost_limit,
        output=options.output,
        exit_immediately=options.exit_immediately,
    )

    # Keep long-lived yolo runs cheap: imported implementation objects are
    # permanent, while per-step payloads remain collectible by generation 0.
    from minisweagent.agents import get_agent
    from minisweagent.environments import get_environment
    from minisweagent.models import get_model

    # A TUI is not attached to a terminal, so the non-interactive DefaultAgent
    # is the safe default. An explicit -c agent.agent_class=interactive still
    # imports the interactive class on demand and keeps its confirmation UX.
    agent_config = config.get("agent", {})
    default_agent = "default"
    if agent_config.get("agent_class") == "interactive":
        # Import only for the exceptional interactive-config path.
        from minisweagent.agents.interactive import InteractiveAgent  # noqa: F401

        default_agent = "interactive"
    # Freeze imported implementation state before constructing run instances.
    # Old model/agent objects must remain collectible when /model replaces them.
    gc.freeze()
    model = get_model(config=config.get("model", {}))
    environment = get_environment(config.get("environment", {}), default_type="local")
    agent = get_agent(model, environment, agent_config, default_type=default_agent)

    resume_messages = None
    if options.resume is not None:
        resume_messages = json.loads(options.resume.read_text(encoding="utf-8")).get("messages", [])
    if resume_messages:
        agent.run(options.task or "", resume_messages=resume_messages)
    else:
        agent.run(options.task or "")
    return agent


def cli_main(argv: list[str] | None = None) -> object:
    """Compatibility API for the benchmark and Python embedders."""
    return _run_cli_main(argv)


def main(argv: list[str] | None = None) -> int:
    """Console-script entry point with concise argument/runtime errors."""
    try:
        _run_cli_main(argv)
    except UsageError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
