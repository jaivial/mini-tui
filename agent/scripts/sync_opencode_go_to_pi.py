#!/usr/bin/env python3

"""Sync the OpenCode Go model profile into pi's `~/.pi/agent/models.json`.

`src/minisweagent/models/opencode_go_model.py` holds the OpenCode Go catalog (every id
from the `Endpoints` table at https://opencode.ai/docs/go/#endpoints, with the prices
and monthly budgets from the same page). This script turns that table into the
`opencode-go` provider entry pi expects, so both tools agree on ids, endpoints and
prices:

    python scripts/sync_opencode_go_to_pi.py            # write ~/.pi/agent/models.json
    python scripts/sync_opencode_go_to_pi.py --dry-run  # print the provider entry
    python scripts/sync_opencode_go_to_pi.py --models-path /tmp/models.json

pi already knows the `opencode-go` provider id (it sends `x-opencode-session` for it
automatically, including `x-opencode-client`), so the entry only has to carry the key
and the per-model endpoint,
prices and context windows. Defining `models` replaces pi's built-in catalog for this
provider, so metadata missing from the docs is copied from pi's own catalog when
available (see --pi-catalog).
"""

import argparse
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

from minisweagent.models.opencode_go_model import (
    ANTHROPIC_API_BASE,
    DEFAULT_API_BASE,
    OPENCODE_GO_MODELS,
    GoModelInfo,
)

#: pi api name for each Go endpoint flavor.
PI_API = {
    "chat": "openai-completions",
    "messages": "anthropic-messages",
    "responses": "openai-responses",
}

DEFAULT_MODELS_PATH = Path.home() / ".pi" / "agent" / "models.json"

CANDIDATE_CATALOGS = [
    Path.home()
    / ".local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json",
    Path(
        "/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json"
    ),
]

#: Fallback metadata for ids that pi's own catalog does not list (yet). Values are copied
#: from the closest sibling in that catalog; `pi_catalog_id` names the donor.
FALLBACKS: dict[str, str] = {
    # Same backend as deepseek-v4-flash, served through the same OpenAI compatible flavor.
    "deepseek-v4.1-flash": "deepseek-v4-flash",
    # Same backend as minimax-m2.7.
    "minimax-m2.5": "minimax-m2.7",
    # pi lists this model under its previous id.
    "union-alpha": "omen-alpha",
    # New since the last docs refresh — metadata copied from the closest sibling.
    "grok-4.7": "grok-4.6",
    "mimo-v2.6-flash": "mimo-v2.5",
    "mimo-v2.6-pro": "mimo-v2.5-pro",
    "space-bunny-free": "omen-alpha",
}


def load_pi_catalog(path: Path | None) -> dict[str, dict]:
    """Read pi's own opencode-go catalog, used to fill in fields the docs omit."""
    candidates = [path] if path else CANDIDATE_CATALOGS
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            data = json.loads(Path(candidate).read_text())
            return {model_id: model for models in data.values() for model_id, model in models.items()}
    print("note: pi's opencode-go catalog not found, using built-in fallbacks only", file=sys.stderr)
    return {}


def pi_model(model: GoModelInfo, catalog: dict[str, dict]) -> dict:
    """Build one pi model entry from the shared table plus pi's own metadata."""
    donor = catalog.get(model.id) or catalog.get(FALLBACKS.get(model.id, "")) or {}
    entry: dict = {
        "id": model.id,
        "name": donor.get("name") or model.name,
        "api": PI_API[model.endpoint],
        "baseUrl": ANTHROPIC_API_BASE if model.endpoint == "messages" else DEFAULT_API_BASE,
        "reasoning": bool(donor.get("reasoning", model.reasoning)),
        "input": list(donor.get("input") or model.input_modalities),
        "cost": {
            "input": model.input,
            "output": model.output,
            "cacheRead": model.cache_read,
            "cacheWrite": model.cache_write,
        },
        "contextWindow": int(donor.get("contextWindow") or model.context_window),
        "maxTokens": int(donor.get("maxTokens") or model.max_tokens),
    }
    # The docs list a second price tier for some models (Grok 4.6, GPT 5.6 Luna, Qwen Plus).
    if model.tiered:
        entry["cost"]["tiers"] = [
            {
                "inputTokensAbove": model.tier_threshold,
                "input": model.tier_input,
                "output": model.tier_output,
                "cacheRead": model.tier_cache_read,
                "cacheWrite": model.tier_cache_write,
            }
        ]
    for key in ("compat", "thinkingLevelMap"):
        if donor.get(key):
            entry[key] = donor[key]
    return entry


def build_provider(catalog: dict[str, dict], api_key: str) -> dict:
    return {
        "name": "OpenCode Go",
        "baseUrl": DEFAULT_API_BASE,
        "api": "openai-completions",
        "apiKey": api_key,
        "models": [pi_model(model, catalog) for model in OPENCODE_GO_MODELS],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--models-path", type=Path, default=DEFAULT_MODELS_PATH, help="pi models.json path")
    parser.add_argument("--pi-catalog", type=Path, default=None, help="pi's opencode-go.json catalog for metadata")
    parser.add_argument("--api-key", default=None, help="API key to store (default: keep what is there)")
    parser.add_argument("--dry-run", action="store_true", help="Print the provider entry instead of writing it")
    args = parser.parse_args()

    api_key = args.api_key
    current: dict = {}
    if args.models_path.is_file():
        current = json.loads(args.models_path.read_text())
        api_key = api_key or current.get("providers", {}).get("opencode-go", {}).get("apiKey")
    if not api_key:
        parser.error(f"no API key found in {args.models_path}, pass --api-key")

    provider = build_provider(load_pi_catalog(args.pi_catalog), api_key)

    if args.dry_run:
        print(json.dumps({"opencode-go": provider}, indent=2))
        return

    args.models_path.parent.mkdir(parents=True, exist_ok=True)
    if args.models_path.is_file():
        backup = args.models_path.parent / f"{args.models_path.name}.bak-pre-opencode-go-{datetime.now():%Y%m%d-%H%M%S}"
        shutil.copy2(args.models_path, backup)
        print(f"backed up {args.models_path} -> {backup}")
    current.setdefault("providers", {})["opencode-go"] = provider
    args.models_path.write_text(json.dumps(current, indent=2) + "\n")
    print(f"wrote {len(provider['models'])} OpenCode Go models to {args.models_path}")


if __name__ == "__main__":
    main()
