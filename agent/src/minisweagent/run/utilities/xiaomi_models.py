#!/usr/bin/env python3

"""List the models available from the Xiaomi MiMo API.

Every id printed here can be passed to `mini` by prefixing it with `xiaomi/`
(bare ids work too), for example:

    mini -m xiaomi/mimo-v2.6-pro

The speech/audio ids (`*-asr`, `*-tts*`) are listed as well, but they cannot
drive the agent loop.
"""

import os

import requests
from rich.console import Console
from rich.table import Table
from typer import Option, Typer

from minisweagent.models.xiaomi_model import DEFAULT_API_BASE, DEFAULT_API_KEY, XIAOMI_PREFIX

app = Typer(help=__doc__, no_args_is_help=False, rich_markup_mode="rich", add_completion=False)
console = Console(highlight=False)


def fetch_models(api_base: str, api_key: str) -> list[dict]:
    """Fetch the model list from Xiaomi's `/models` endpoint."""
    response = requests.get(
        f"{api_base.rstrip('/')}/models",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=30,
    )
    response.raise_for_status()
    return response.json().get("data", [])


@app.command()
def main(
    filter: str = Option("", "-f", "--filter", help="Only show models whose id contains this substring."),
    plain: bool = Option(False, "--plain", help="Print bare model names, one per line."),
    api_base: str = Option(None, "--api-base", help="Xiaomi API base URL."),
    api_key: str = Option(None, "--api-key", help="Xiaomi API key."),
) -> None:
    """List Xiaomi MiMo models usable as `xiaomi/<id>`."""
    api_base = api_base or os.getenv("XIAOMI_API_BASE", DEFAULT_API_BASE)
    api_key = api_key or os.getenv("XIAOMI_API_KEY", DEFAULT_API_KEY)
    if not api_key:
        console.print(
            "[bold red]No Xiaomi API key set.[/bold red] "
            "Run [green]mini-extra config set XIAOMI_API_KEY YOUR_KEY[/green]."
        )
        raise SystemExit(1)

    try:
        models = fetch_models(api_base, api_key)
    except Exception as e:
        console.print(f"[bold red]Could not reach the Xiaomi MiMo API at {api_base}:[/bold red] {e}")
        raise SystemExit(1) from e

    if filter:
        models = [m for m in models if filter.lower() in m.get("id", "").lower()]

    if plain:
        for m in models:
            print(f"{XIAOMI_PREFIX}{m.get('id', '')}")
        return

    table = Table(title=f"Xiaomi MiMo models ({len(models)}) at {api_base}")
    table.add_column("use with mini -m", style="bold green", overflow="fold")
    table.add_column("owner")
    for m in models:
        table.add_row(f"{XIAOMI_PREFIX}{m.get('id', '')}", str(m.get("owned_by", "")))
    console.print(table)


if __name__ == "__main__":
    app()
