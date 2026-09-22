import importlib.util
import json
from pathlib import Path

import pytest

from minisweagent.models.opencode_go_model import (
    ANTHROPIC_API_BASE,
    DEFAULT_API_BASE,
    OPENCODE_GO_MODELS,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "sync_opencode_go_to_pi.py"


@pytest.fixture(scope="module")
def sync():
    spec = importlib.util.spec_from_file_location("sync_opencode_go_to_pi", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_provider_carries_every_documented_model(sync):
    provider = sync.build_provider({}, "sk-test")
    assert [m["id"] for m in provider["models"]] == [m.id for m in OPENCODE_GO_MODELS]
    assert provider["apiKey"] == "sk-test"
    assert provider["baseUrl"] == DEFAULT_API_BASE


def test_each_model_gets_the_documented_endpoint(sync):
    provider = sync.build_provider({}, "sk-test")
    by_id = {m["id"]: m for m in provider["models"]}
    assert by_id["glm-5.3-flash"]["api"] == "openai-completions"
    assert by_id["glm-5.3-flash"]["baseUrl"] == DEFAULT_API_BASE
    # The Anthropic compatible flavor hangs off the gateway root, pi appends /v1/messages.
    assert by_id["minimax-m3"]["api"] == "anthropic-messages"
    assert by_id["minimax-m3"]["baseUrl"] == ANTHROPIC_API_BASE
    assert by_id["grok-4.6"]["api"] == "openai-responses"
    assert by_id["grok-4.6"]["baseUrl"] == DEFAULT_API_BASE


def test_prices_and_tiers_are_copied(sync):
    provider = sync.build_provider({}, "sk-test")
    by_id = {m["id"]: m for m in provider["models"]}
    assert by_id["kimi-k3"]["cost"] == {"input": 3.0, "output": 15.0, "cacheRead": 0.3, "cacheWrite": 0.0}
    assert by_id["grok-4.6"]["cost"]["tiers"] == [
        {"inputTokensAbove": 200000, "input": 4.0, "output": 12.0, "cacheRead": 1.0, "cacheWrite": 0.0}
    ]
    assert "tiers" not in by_id["kimi-k3"]["cost"]
    assert by_id["union-alpha"]["cost"]["input"] == 0


def test_pi_metadata_is_preferred_over_the_docs(sync):
    """pi's own catalog knows context windows and compat quirks the docs omit."""
    catalog = {
        "kimi-k3": {
            "name": "Kimi K3 (pi)",
            "contextWindow": 123456,
            "maxTokens": 4321,
            "compat": {"supportsStore": False},
            "thinkingLevelMap": {"high": "high"},
            "input": ["text"],
        }
    }
    entry = sync.pi_model(next(m for m in OPENCODE_GO_MODELS if m.id == "kimi-k3"), catalog)
    assert entry["name"] == "Kimi K3 (pi)"
    assert entry["contextWindow"] == 123456
    assert entry["maxTokens"] == 4321
    assert entry["compat"] == {"supportsStore": False}
    assert entry["thinkingLevelMap"] == {"high": "high"}
    assert entry["input"] == ["text"]


def test_unknown_ids_get_sibling_fallbacks(sync):
    entry = sync.pi_model(next(m for m in OPENCODE_GO_MODELS if m.id == "minimax-m2.5"), {})
    assert entry["contextWindow"] == 204800
    assert entry["api"] == "anthropic-messages"


def test_writing_replaces_only_the_opencode_go_provider(sync, tmp_path):
    models_path = tmp_path / "models.json"
    models_path.write_text(json.dumps({"providers": {"deepseek": {"name": "DeepSeek", "models": []}}}))
    import sys

    argv = ["--models-path", str(models_path), "--api-key", "sk-test"]

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(sys, "argv", ["sync_opencode_go_to_pi.py", *argv])
        sync.main()
    data = json.loads(models_path.read_text())
    assert set(data["providers"]) == {"deepseek", "opencode-go"}
    assert len(data["providers"]["opencode-go"]["models"]) == len(OPENCODE_GO_MODELS)
    assert list(models_path.parent.glob("*.bak-pre-opencode-go-*"))
