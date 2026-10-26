"""Shared mini-tui model metadata reaches the real model configurations."""

from pathlib import Path

import pytest

from minisweagent.models.anthropic_compat_model import AnthropicCompatModel
from minisweagent.models.limits import model_limits
from minisweagent.models.openai_compat_model import OpenaiCompatModel
from minisweagent.models.opencode_go_model import OPENCODE_GO_MODELS, OpencodeGoModel
from minisweagent.models.openai_model import OpenaiResponseModel


ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(autouse=True)
def shared_catalog(monkeypatch):
    monkeypatch.setenv("MINITUI_HOME", str(ROOT))
    monkeypatch.delenv("MSWEA_CONTEXT_WINDOW", raising=False)
    monkeypatch.delenv("MSWEA_MAX_TOKENS", raising=False)


def output_cap(model):
    # Messages reads model_kwargs.max_tokens before its scalar fallback.
    return model.config.model_kwargs.get("max_tokens", getattr(model.config, "max_tokens", None))


def test_chat_messages_and_responses_limits():
    chat = OpenaiCompatModel(model_name="zai/glm-5.3-flash")
    assert chat.config.context_window == 1_000_000
    assert output_cap(chat) == 131_072

    messages = AnthropicCompatModel(model_name="anthropic/claude-opus-4-1")
    assert messages.config.context_window == 200_000
    assert output_cap(messages) == 32_000

    responses = OpenaiResponseModel(model_name="openai/gpt-6-astra")
    assert responses.config.context_window == 272_000
    assert output_cap(responses) == 128_000


def test_opencode_table_and_shared_catalog_agree_for_every_model():
    for info in OPENCODE_GO_MODELS:
        qualified = f"opencode-go/{info.id}"
        assert model_limits(qualified) == {
            "context_window": info.context_window,
            "max_output_tokens": info.max_tokens,
        }
        model = OpencodeGoModel(model_name=qualified)
        assert model.config.context_window == info.context_window
        assert output_cap(model) == info.max_tokens


def test_explicit_config_and_environment_precedence(monkeypatch):
    explicit = OpenaiCompatModel(
        model_name="zai/glm-5.3-flash", context_window=1234, model_kwargs={"max_tokens": 4321}
    )
    assert explicit.config.context_window == 1234
    assert output_cap(explicit) == 4321

    monkeypatch.setenv("MSWEA_CONTEXT_WINDOW", "2345")
    monkeypatch.setenv("MSWEA_MAX_TOKENS", "5432")
    overridden = OpenaiCompatModel(model_name="zai/glm-5.3-flash")
    assert overridden.config.context_window == 2345
    assert output_cap(overridden) == 5432

    # An explicit model config still wins over the process-wide defaults.
    assert OpenaiCompatModel(
        model_name="zai/glm-5.3-flash", context_window=1234, model_kwargs={"max_tokens": 4321}
    ).config.context_window == 1234


def test_bare_native_ids_and_unknown_local_models():
    assert model_limits("deepseek-chat") == model_limits("deepseek/deepseek-chat")
    assert model_limits("ollama/local-model") is None
