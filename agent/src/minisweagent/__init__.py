"""
This file provides:

- Path settings for global config file & relative directories
- Version numbering
- Protocols for the core components of mini-swe-agent.
  By the magic of protocols & duck typing, you can pretty much ignore them,
  unless you want the static type checking.
"""

__version__ = "2.4.6"

import logging
import os
from pathlib import Path
from typing import Any, Protocol

from dotenv import load_dotenv
from platformdirs import user_config_dir

package_dir = Path(__file__).resolve().parent

global_config_dir = Path(os.getenv("MSWEA_GLOBAL_CONFIG_DIR") or user_config_dir("mini-swe-agent"))
global_config_dir.mkdir(parents=True, exist_ok=True)
global_config_file = Path(global_config_dir) / ".env"

logger = logging.getLogger("minisweagent")
# ``import minisweagent.utils.log`` remains a supported, explicit request for
# Rich-formatted logging. Importing the package itself no longer pays that cost.
silent_startup = bool(os.getenv("MSWEA_SILENT_STARTUP"))
if not silent_startup:
    # Rich is a substantial import. Keep it out of embedded/headless runs; the
    # public Typer CLI imports Rich immediately afterwards for its normal output.
    from rich.console import Console

    Console().print(
        f"This is [bold green]mini-swe-agent[/bold green] version [bold green]{__version__}[/bold green].\n"
        f"Check the [bold red]v2 migration guide[/] at [bold red]https://klieret.short.gy/mini-v2-migration[/]\n"
        f"Loading global config from [bold green]'{global_config_file}'[/bold green]",
    )
if silent_startup:
    load_dotenv(dotenv_path=global_config_file)
if not silent_startup:
    # Preserve the public CLI's rich log handler without making silent embedded
    # imports pay for it.
    from minisweagent.utils.log import logger as _rich_logger

    logger = _rich_logger
    load_dotenv(dotenv_path=global_config_file)


# === Protocols ===
# You can ignore them unless you want static type checking.


class Model(Protocol):
    """Protocol for language models."""

    config: Any

    def query(self, messages: list[dict[str, str]], **kwargs) -> dict: ...

    def format_message(self, **kwargs) -> dict: ...

    def format_observation_messages(
        self, message: dict, outputs: list[dict], template_vars: dict | None = None
    ) -> list[dict]: ...

    def get_template_vars(self, **kwargs) -> dict[str, Any]: ...

    def serialize(self) -> dict: ...


class Environment(Protocol):
    """Protocol for execution environments."""

    config: Any

    def execute(self, action: dict, cwd: str = "") -> dict[str, Any]: ...

    def get_template_vars(self, **kwargs) -> dict[str, Any]: ...

    def serialize(self) -> dict: ...


class Agent(Protocol):
    """Protocol for agents."""

    config: Any

    def run(self, task: str, **kwargs) -> dict: ...

    def save(self, path: Path | None, *extra_dicts, force: bool = True) -> dict: ...


__all__ = [
    "Agent",
    "Model",
    "Environment",
    "package_dir",
    "__version__",
    "global_config_file",
    "global_config_dir",
    "logger",
]
