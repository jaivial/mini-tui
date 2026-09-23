"""Per-provider token prices — cost tracking without litellm's registry.

Prices are US dollars per 1M tokens. Rows are a snapshot of the providers' published
prices (2026-09-23; mirrored from litellm's registry where it knew the id). Ids without
a row — and subscription/gateway endpoints altogether — cost 0.0, exactly what
litellm did for ids it had no prices for. Extra rows can be added with
``MSWEA_PRICE_TABLE_PATH`` pointing at a JSON file: ``{"<provider>": {"<id>": [in, out,
cache_read, cache_write]}}`` (per 1M tokens; cache fields optional).
"""

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Price:
    """US dollars per 1M tokens. `tier_*` implements per-request tiered pricing: when
    `tier_threshold` is set, requests over that many input tokens bill at the tier prices."""

    input: float = 0.0
    output: float = 0.0
    cache_read: float = 0.0
    cache_write: float = 0.0
    tier_threshold: int = 0
    tier_input: float = 0.0
    tier_output: float = 0.0
    tier_cache_read: float = 0.0
    tier_cache_write: float = 0.0


def _p(i: float, o: float, cr: float = 0.0, cw: float = 0.0) -> Price:
    return Price(input=i, output=o, cache_read=cr, cache_write=cw)


#: {provider key: {wire model id: Price}} — keyed per provider because the same id can be
#: billed by different providers at different prices (e.g. `deepseek-v4-flash` on the
#: DeepSeek API vs on OpenCode Go).
PRICES: dict[str, dict[str, Price]] = {
    "deepseek": {
        "deepseek-chat": _p(0.28, 0.42, 0.028),
        "deepseek-reasoner": _p(0.28, 0.42, 0.028),
        "deepseek-flash": _p(0.30, 1.20, 0.006),
        "deepseek-v4-flash": _p(0.30, 1.20, 0.006),
        "deepseek-v4-pro": _p(1.32, 3.96, 0.044),
        "deepseek-v4-flash-vision-exp": _p(0.30, 1.20, 0.006),
    },
    "openai": {
        "gpt-6-astra": _p(10.0, 50.0, 1.0, 12.5),
        "gpt-5.4": _p(2.5, 15.0, 0.25),
        "gpt-4o-mini": _p(0.15, 0.60, 0.075),
    },
    "anthropic": {
        "claude-sonnet-4-5": _p(3.0, 15.0, 0.30, 3.75),
        "claude-haiku-4-5": _p(1.0, 5.0, 0.10, 1.25),
        "claude-opus-5-5": _p(4.0, 20.0, 0.20, 5.0),
    },
    "opencode-go": {},
    "generic": {},
}

def register_prices(provider: str, rows: dict[str, Price]) -> None:
    """Add or replace price rows (used by provider catalogs and tests)."""
    PRICES.setdefault(provider, {}).update(rows)


def price_for(provider: str, model_id: str) -> Price | None:
    """Price row for `model_id` on `provider`, else None (unknown ids cost 0.0)."""
    table = PRICES.get(provider, {})
    bare = model_id.split("/", 1)[-1].lower()
    for key in (model_id.lower(), bare):
        if key in table:
            return table[key]
    # Fall back to the generic table for BYOK endpoints re-serving priced ids.
    generic = PRICES.get("generic", {})
    return generic.get(model_id.lower()) or generic.get(bare)


def _tokens(usage: Any) -> tuple[int, int, int, int]:
    """(billable input, output, cache-read, cache-write) from any of the usage conventions.

    OpenAI counts cached tokens *inside* `prompt_tokens`, Anthropic reports uncached
    `input_tokens` next to the cache counters — subtract accordingly.
    """
    if not isinstance(usage, dict):
        return 0, 0, 0, 0
    details = usage.get("prompt_tokens_details") or {}
    n_cache_read = int(usage.get("cache_read_input_tokens") or (details.get("cached_tokens") if isinstance(details, dict) else 0) or 0)
    n_cache_write = int(usage.get("cache_creation_input_tokens") or 0)
    if "prompt_tokens" in usage or "completion_tokens" in usage:
        n_in = max(0, int(usage.get("prompt_tokens") or 0) - n_cache_read)
        n_out = int(usage.get("completion_tokens") or 0)
    else:
        n_in = int(usage.get("input_tokens") or 0)
        n_out = int(usage.get("output_tokens") or 0)
    return n_in, n_out, n_cache_read, n_cache_write


def cost_for(provider: str, model_id: str, usage: Any) -> float:
    """Cost of one call in USD (0.0 for unknown ids — same as litellm's behavior)."""
    price = price_for(provider, model_id)
    if price is None:
        return 0.0
    n_in, n_out, n_cache_read, n_cache_write = _tokens(usage)
    p_in, p_out, p_cr, p_cw = price.input, price.output, price.cache_read, price.cache_write
    if price.tier_threshold and n_in > price.tier_threshold:
        p_in, p_out, p_cr, p_cw = price.tier_input, price.tier_output, price.tier_cache_read, price.tier_cache_write
    return (n_in * p_in + n_out * p_out + n_cache_read * p_cr + n_cache_write * p_cw) / 1e6


def load_price_file(path: str | Path) -> None:
    """Merge a JSON price table (`{provider: {id: [in, out, cache_read?, cache_write?]}}`)."""
    rows = json.loads(Path(path).read_text())
    for provider, ids in rows.items():
        for model_id, costs in ids.items():
            register_prices(provider, {model_id.lower(): _p(*(float(c) for c in costs))})


if os.getenv("MSWEA_PRICE_TABLE_PATH") and Path(os.getenv("MSWEA_PRICE_TABLE_PATH", "")).is_file():
    load_price_file(os.environ["MSWEA_PRICE_TABLE_PATH"])

__all__ = ["Price", "PRICES", "register_prices", "price_for", "cost_for", "load_price_file"]
