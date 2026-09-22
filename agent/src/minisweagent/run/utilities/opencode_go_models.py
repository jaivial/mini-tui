#!/usr/bin/env python3

"""List the models available from OpenCode Go.

Every id printed here can be passed to `mini` by prefixing it with `opencode-go/`, for
example:

    mini -m opencode-go/kimi-k3

The gateway serves its models through three endpoint flavors (see the `Endpoints` table
at https://opencode.ai/docs/go/#endpoints); the table below shows which one each id
uses, plus the documented prices and the included monthly budget.
"""

import os

import requests
from rich.console import Console
from rich.table import Table
from typer import Option, Typer

from minisweagent.models.opencode_go_model import (
    DEFAULT_API_BASE,
    DEFAULT_API_KEY,
    OPENCODE_GO_PREFIX,
    endpoint_for,
    get_model_info,
)

ENDPOINT_LABELS = {
    "chat": "/chat/completions",
    "messages": "/messages",
    "responses": "/responses",
}

app = Typer(help=__doc__, no_args_is_help=False, rich_markup_mode="rich", add_completion=False)
console = Console(highlight=False)


def fetch_models(api_base: str, api_key: str) -> list[dict]:
    """Fetch the model list from OpenCode Go's `/models` endpoint."""
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
    api_base: str = Option(None, "--api-base", help="OpenCode Go API base URL."),
    api_key: str = Option(None, "--api-key", help="OpenCode Go API key."),
) -> None:
    """List OpenCode Go models usable as `opencode-go/<id>`."""
    api_base = api_base or os.getenv("OPENCODE_GO_API_BASE", DEFAULT_API_BASE)
    api_key = api_key or os.getenv("OPENCODE_GO_API_KEY", DEFAULT_API_KEY)
    if not api_key:
        console.print(
            "[bold red]No OpenCode Go API key set.[/bold red] "
            "Run [green]mini-extra config set OPENCODE_GO_API_KEY YOUR_KEY[/green]."
        )
        raise SystemExit(1)

    try:
        models = fetch_models(api_base, api_key)
    except Exception as e:
        console.print(f"[bold red]Could not reach the OpenCode Go API at {api_base}:[/bold red] {e}")
        raise SystemExit(1) from e

    if plain:
        for m in models:
            print(f"{OPENCODE_GO_PREFIX}{m.get('id', '')}")
        return

    table = Table(title=f"OpenCode Go models ({len(models)}) at {api_base}")
    table.add_column("use with mini -m", style="bold green", overflow="fold")
    table.add_column("endpoint")
    table.add_column("in/out $/1M", justify="right")
    table.add_column("$ / month", justify="right")
    for m in models:
        info = get_model_info(str(m.get("id", "")))
        if info:
            prices = (
                f"{info.input:g} / {info.output:g}"
                if not info.tiered
                else f"{info.input:g} / {info.output:g} (> {info.tier_threshold // 1000}K: {info.tier_input:g} / {info.tier_output:g})"
            )
            table.add_row(
                f"{OPENCODE_GO_PREFIX}{info.id}",
                ENDPOINT_LABELS[info.endpoint],
                prices,
                "free" if info.free else str(info.monthly_limit),
            )
        else:
            table.add_row(
                f"{OPENCODE_GO_PREFIX}{m.get('id', '')}",
                f"{ENDPOINT_LABELS[endpoint_for(str(m.get('id', '')))]} *",
                "?",
                "?",
            )
    console.print(table)
    console.print("[dim]* not documented yet, served as OpenAI compatible /chat/completions[/dim]")


if __name__ == "__main__":
    app()
