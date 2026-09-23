"""Provider registry — one row per provider (prefix, base URL env, protocol)."""

import os
from unittest.mock import patch

from minisweagent.models.providers import PROVIDERS, lookup, protocol_for


def test_lookup_matches_on_prefix():
    assert lookup("moonshot/kimi-k2").id == "moonshot"
    assert lookup("zai/glm-5.3").id == "zai"
    assert lookup("minimax/MiniMax-M3").id == "minimax"
    assert lookup("anthropic/claude-sonnet-4-5").protocol == "messages"
    assert lookup("deepseek/deepseek-chat") is None  # quirks live in its own model class
    assert lookup("totally-unknown/x") is None


def test_protocol_for():
    assert protocol_for("moonshot/kimi-k2") == "chat"
    assert protocol_for("anthropic/claude-opus-5-5") == "messages"
    assert protocol_for("unknown/x") is None


def test_strip_removes_only_the_routing_prefix():
    assert lookup("zai/").strip("zai/glm-5.3") == "glm-5.3"
    assert lookup("zai/").strip("other/glm-5.3") == "other/glm-5.3"


def test_settings_env_overrides_the_default():
    provider = lookup("zai/glm-5.3")
    assert provider.settings() == ("https://api.z.ai/api/coding/paas/v4", "")
    with patch.dict(os.environ, {"ZAI_API_BASE": "http://zai.local:8000/v1/", "ZAI_API_KEY": "sk-z"}):
        assert provider.settings() == ("http://zai.local:8000/v1", "sk-z")


def test_every_provider_has_its_own_env_slot():
    bases = [p.base_env for p in PROVIDERS]
    keys = [p.key_env for p in PROVIDERS]
    assert len(bases) == len(set(bases)) == len(set(keys))
    assert "OPENAI_API_BASE" not in bases  # no shared slot: two BYOK providers can coexist
