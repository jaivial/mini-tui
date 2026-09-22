import os
from unittest.mock import patch

import pytest

from minisweagent.models import get_model, get_model_class
from minisweagent.models.rosetta_model import (
    DEFAULT_API_BASE,
    DEFAULT_API_KEY,
    RosettaModel,
    is_rosetta_model,
    strip_rosetta_prefix,
)


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("rosetta/zai-glm/glm-4.6", True),
        ("Rosetta/zai-glm/glm-4.6", True),
        ("anthropic/claude-sonnet-4-5-20250929", False),
        ("openai/gpt-5.4", False),
        ("my-rosetta/model", False),
    ],
)
def test_is_rosetta_model(name, expected):
    assert is_rosetta_model(name) is expected


def test_strip_rosetta_prefix():
    assert strip_rosetta_prefix("rosetta/zai-glm/glm-4.6") == "zai-glm/glm-4.6"
    # Non-rosetta names pass through untouched.
    assert strip_rosetta_prefix("openai/gpt-5.4") == "openai/gpt-5.4"


def test_get_model_class_routes_rosetta():
    assert get_model_class("rosetta/zai-glm/glm-4.6") is RosettaModel


def test_explicit_model_class_wins_over_prefix():
    from minisweagent.models.litellm_model import LitellmModel

    assert get_model_class("rosetta/zai-glm/glm-4.6", "litellm") is LitellmModel


def test_rosetta_model_defaults():
    model = get_model("rosetta/zai-glm/glm-4.6")
    assert isinstance(model, RosettaModel)
    # The rosetta/ prefix is replaced by litellm's openai provider prefix.
    assert model.config.model_name == "openai/zai-glm/glm-4.6"
    assert model.config.model_kwargs["custom_llm_provider"] == "openai"
    assert model.config.model_kwargs["api_base"] == DEFAULT_API_BASE
    assert model.config.model_kwargs["api_key"] == DEFAULT_API_KEY
    assert model.config.model_kwargs["drop_params"] is True
    # Rosetta reports no per-token cost, so cost errors must not abort a run.
    assert model.config.cost_tracking == "ignore_errors"


def test_rosetta_model_respects_env_overrides():
    with patch.dict(os.environ, {"ROSETTA_API_BASE": "http://example.com:1234/v1/", "ROSETTA_API_KEY": "secret"}):
        model = get_model("rosetta/zai-glm/glm-4.6")
    assert model.config.model_kwargs["api_base"] == "http://example.com:1234/v1"
    assert model.config.model_kwargs["api_key"] == "secret"


def test_explicit_model_kwargs_are_not_overridden():
    model = get_model("rosetta/zai-glm/glm-4.6", {"model_kwargs": {"api_base": "http://custom/v1", "temperature": 0.3}})
    assert model.config.model_kwargs["api_base"] == "http://custom/v1"
    assert model.config.model_kwargs["temperature"] == 0.3
    # Defaults still fill in the gaps.
    assert model.config.model_kwargs["api_key"] == DEFAULT_API_KEY


def test_rosetta_does_not_get_anthropic_cache_control():
    """Rosetta ids often contain "claude" but speak the OpenAI protocol."""
    model = get_model("rosetta/claude-codex/claude-codex-gpt-5.5")
    assert model.config.set_cache_control is None


def test_real_anthropic_still_gets_cache_control():
    model = get_model("anthropic/claude-sonnet-4-5-20250929")
    assert model.config.set_cache_control == "default_end"


def test_explicit_cache_control_is_respected():
    model = get_model("rosetta/claude-codex/claude-codex-gpt-5.5", {"set_cache_control": "default_end"})
    assert model.config.set_cache_control == "default_end"
