#!/usr/bin/env python3

"""List the models available from the cli-proxy-api gateway.

Every id printed here can be passed to `mini` by prefixing it with `cliproxy/`,
for example:

    mini -m cliproxy/claude-sonnet-4-5-20250929
"""

import os

import requests
from rich.console import Console
from rich.table import Table
from typer import Option, Typer

from minisweagent.models.cliproxy_model import (
    CLIPROXY_PREFIX,
    DEFAULT_API_BASE,
    DEFAULT_API_KEY,
)

app = Typer(help=__doc__, no_args_is_help=False, rich_markup_mode="rich", add_completion=False)
console = Console(highlight=False)


def fetch_models(api_base: str, api_key: str) -> list[dict]:
    """Fetch the model list from cli-proxy-api's `/v1/models` endpoint."""
    url = f"{api_base.rstrip('/')}/models"
    response = requests.get(
        url,
        headers={"x-api-key": api_key, "Authorization": f"Bearer {api_key}"},
        timeout=30,
    )
    response.raise_for_status()
    return response.json().get("data", [])


@app.command()
def main(
    filter: str = Option("", "-f", "--filter", help="Only show models whose id contains this substring."),
    plain: bool = Option(False, "--plain", help="Print bare model names, one per line."),
    api_base: str = Option(None, "--api-base", help="cli-proxy-api base URL."),
) -> None:
    """List cli-proxy-api models usable as `cliproxy/<id>`."""
    api_base = api_base or os.getenv("CLIPROXY_API_BASE", DEFAULT_API_BASE)
    api_key = os.getenv("CLIPROXY_API_KEY", DEFAULT_API_KEY)

    try:
        models = fetch_models(api_base, api_key)
    except Exception as e:
        console.print(f"[bold red]Could not reach cli-proxy-api at {api_base}:[/bold red] {e}")
        raise SystemExit(1) from e

    if filter:
        models = [m for m in models if filter.lower() in m.get("id", "").lower()]

    if not models:
        console.print("[yellow]No matching models.[/yellow]")
        return

    if plain:
        for m in models:
            print(f"{CLIPROXY_PREFIX}{m['id']}")
        return

    table = Table(title=f"cli-proxy-api models ({len(models)}) at {api_base}")
    table.add_column("use with mini -m", style="bold green", overflow="fold")
    table.add_column("backend")
    for m in models:
        table.add_row(
            f"{CLIPROXY_PREFIX}{m.get('id', '')}",
            str(m.get("owned_by", "")),
        )
    console.print(table)


if __name__ == "__main__":
    app()
