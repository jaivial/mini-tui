"""Per-provider price tables — cost tracking without litellm."""

import json

import pytest

from minisweagent.models import prices
from minisweagent.models.prices import Price, cost_for, load_price_file, price_for, register_prices


def test_known_id_costs_in_and_out():
    usage = {"prompt_tokens": 1_000_000, "completion_tokens": 500_000}
    assert cost_for("deepseek", "deepseek-chat", usage) == pytest.approx(0.28 + 500_000 * 0.42 / 1e6)


def test_cache_tokens_bill_at_cache_prices():
    usage = {"prompt_tokens": 2_000_000, "completion_tokens": 0, "prompt_tokens_details": {"cached_tokens": 2_000_000}}
    # all input cached: 2M at the cache-read price of 0.028/1M
    assert cost_for("deepseek", "deepseek-chat", usage) == pytest.approx(2 * 0.028)


def test_anthropic_usage_convention():
    usage = {"input_tokens": 1_000_000, "output_tokens": 1_000_000, "cache_read_input_tokens": 1_000_000}
    assert cost_for("anthropic", "claude-sonnet-4-5", usage) == pytest.approx(3.0 + 15.0 + 0.3)


def test_unknown_id_costs_zero():
    assert cost_for("deepseek", "deepseek-nope", {"prompt_tokens": 10, "completion_tokens": 10}) == 0.0
    assert price_for("deepseek", "deepseek-nope") is None


def test_routing_prefixes_are_stripped_for_lookup():
    assert price_for("deepseek", "deepseek/deepseek-chat") == price_for("deepseek", "deepseek-chat")
    assert price_for("openai", "openai/gpt-5.4") is not None


def test_same_id_can_be_priced_per_provider():
    register_prices("opencode-go", {"deepseek-v4-flash": Price(input=9.0, output=9.0)})
    assert cost_for("opencode-go", "deepseek-v4-flash", {"input_tokens": 1_000_000, "output_tokens": 0}) == pytest.approx(9.0)
    assert cost_for("deepseek", "deepseek-v4-flash", {"input_tokens": 1_000_000, "output_tokens": 0}) == pytest.approx(0.30)


def test_tiered_pricing_switches_over_the_threshold():
    register_prices("t", {"tiered": Price(input=1.0, output=1.0, tier_threshold=100, tier_input=4.0, tier_output=4.0)})
    assert cost_for("t", "tiered", {"input_tokens": 100, "output_tokens": 0}) == pytest.approx(100 * 1.0 / 1e6)
    assert cost_for("t", "tiered", {"input_tokens": 101, "output_tokens": 0}) == pytest.approx(101 * 4.0 / 1e6)


def test_price_file_extends_the_table(tmp_path):
    path = tmp_path / "prices.json"
    path.write_text(json.dumps({"custom": {"my-model": [2.0, 3.0, 0.5, 0.25]}}))
    load_price_file(path)
    usage = {"input_tokens": 1_000_000, "output_tokens": 1_000_000, "cache_read_input_tokens": 1, "cache_creation_input_tokens": 1}
    assert cost_for("custom", "my-model", usage) == pytest.approx(2.0 + 3.0 + 0.5 / 1e6 + 0.25 / 1e6)
