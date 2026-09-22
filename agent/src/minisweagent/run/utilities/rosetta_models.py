#!/usr/bin/env python3

"""List the models available from the Rosetta LLM gateway.

Every id printed here can be passed to `mini` by prefixing it with `rosetta/`,
for example:

    mini -m rosetta/zai-glm/glm-4.6
"""

import os

import requests
from rich.console import Console
from rich.table import Table
from typer import Option, Typer

from minisweagent.models.rosetta_model import DEFAULT_API_BASE, DEFAULT_API_KEY, ROSETTA_PREFIX

app = Typer(help=__doc__, no_args_is_help=False, rich_markup_mode="rich", add_completion=False)
console = Console(highlight=False)


def fetch_models(api_base: str, api_key: str) -> list[dict]:
    """Fetch the model list from a Rosetta gateway's `/v1/models` endpoint."""
    url = f"{api_base.rstrip('/')}/models"
    response = requests.get(url, headers={"x-api-key": api_key, "Authorization": f"Bearer {api_key}"}, timeout=30)
    response.raise_for_status()
    return response.json().get("data", [])


@app.command()
def main(
    filter: str = Option("", "-f", "--filter", help="Only show models whose id contains this substring."),
    plain: bool = Option(False, "--plain", help="Print bare model names, one per line."),
    api_base: str = Option(None, "--api-base", help="Rosetta API base URL."),
) -> None:
    """List Rosetta models usable as `rosetta/<id>`."""
    api_base = api_base or os.getenv("ROSETTA_API_BASE", DEFAULT_API_BASE)
    api_key = os.getenv("ROSETTA_API_KEY", DEFAULT_API_KEY)

    try:
        models = fetch_models(api_base, api_key)
    except Exception as e:
        console.print(f"[bold red]Could not reach the Rosetta gateway at {api_base}:[/bold red] {e}")
        raise SystemExit(1) from e

    if filter:
        models = [m for m in models if filter.lower() in m.get("id", "").lower()]

    if not models:
        console.print("[yellow]No matching models.[/yellow]")
        return

    if plain:
        for m in models:
            print(f"{ROSETTA_PREFIX}{m['id']}")
        return

    table = Table(title=f"Rosetta models ({len(models)}) at {api_base}")
    table.add_column("use with mini -m", style="bold green", overflow="fold")
    table.add_column("backend")
    table.add_column("context", justify="right")
    table.add_column("max out", justify="right")
    for m in models:
        table.add_row(
            f"{ROSETTA_PREFIX}{m.get('id', '')}",
            str(m.get("owned_by", "")),
            f"{m.get('context_length', '') or '':,}" if m.get("context_length") else "",
            f"{m.get('max_tokens', '') or '':,}" if m.get("max_tokens") else "",
        )
    console.print(table)


if __name__ == "__main__":
    app()
