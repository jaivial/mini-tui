#!/usr/bin/env python3

"""List the models available from the DeepSeek API.

Every id printed here can be passed to `mini` by prefixing it with `deepseek/`,
for example:

    mini -m deepseek/deepseek-chat

Ids that `mini` routes to an id DeepSeek serves for them (see
`DEEPSEEK_MODEL_ALIASES`) are listed as well, marked as an alias, because
DeepSeek's `/models` endpoint does not advertise them.
"""

import os

import requests
from rich.console import Console
from rich.table import Table
from typer import Option, Typer

from minisweagent.models.deepseek_model import (
    DEEPSEEK_MODEL_ALIASES,
    DEEPSEEK_PREFIX,
    DEFAULT_API_BASE,
    DEFAULT_API_KEY,
)

app = Typer(help=__doc__, no_args_is_help=False, rich_markup_mode="rich", add_completion=False)
console = Console(highlight=False)


def fetch_models(api_base: str, api_key: str) -> list[dict]:
    """Fetch the model list from DeepSeek's `/models` endpoint."""
    response = requests.get(
        f"{api_base.rstrip('/')}/models",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=30,
    )
    response.raise_for_status()
    return response.json().get("data", [])


@app.command()
def main(
    plain: bool = Option(False, "--plain", help="Print bare model names, one per line."),
    api_base: str = Option(None, "--api-base", help="DeepSeek API base URL."),
    api_key: str = Option(None, "--api-key", help="DeepSeek API key."),
) -> None:
    """List DeepSeek models usable as `deepseek/<id>`."""
    api_base = api_base or os.getenv("DEEPSEEK_API_BASE", DEFAULT_API_BASE)
    api_key = api_key or os.getenv("DEEPSEEK_API_KEY", DEFAULT_API_KEY)
    if not api_key:
        console.print(
            "[bold red]No DeepSeek API key set.[/bold red] "
            "Run [green]mini-extra config set DEEPSEEK_API_KEY YOUR_KEY[/green]."
        )
        raise SystemExit(1)

    try:
        models = fetch_models(api_base, api_key)
    except Exception as e:
        console.print(f"[bold red]Could not reach the DeepSeek API at {api_base}:[/bold red] {e}")
        raise SystemExit(1) from e

    # Ids we route to the id DeepSeek serves for them; they work even when `/models`
    # omits the target, which it does for `deepseek-v4-flash`.
    aliases = sorted(DEEPSEEK_MODEL_ALIASES.items())

    if plain:
        for m in models:
            print(f"{DEEPSEEK_PREFIX}{m.get('id', '')}")
        for alias, _ in aliases:
            print(f"{DEEPSEEK_PREFIX}{alias}")
        return

    table = Table(title=f"DeepSeek models ({len(models) + len(aliases)}) at {api_base}")
    table.add_column("use with mini -m", style="bold green", overflow="fold")
    table.add_column("owner")
    table.add_column("notes", overflow="fold")
    for m in models:
        table.add_row(f"{DEEPSEEK_PREFIX}{m.get('id', '')}", str(m.get("owned_by", "")), "")
    for alias, target in aliases:
        table.add_row(f"{DEEPSEEK_PREFIX}{alias}", "", f"alias of {DEEPSEEK_PREFIX}{target}")
    console.print(table)


if __name__ == "__main__":
    app()
