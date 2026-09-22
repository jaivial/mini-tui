import os
from unittest.mock import patch

import pytest

from minisweagent.models import get_model, get_model_class
from minisweagent.models.litellm_model import LitellmModel
from minisweagent.models.xiaomi_model import (
    DEFAULT_API_BASE,
    DEFAULT_API_KEY,
    XiaomiModel,
    is_xiaomi_model,
    strip_xiaomi_prefix,
)


@pytest.fixture
def clean_env():
    """Keep the developer's XIAOMI_* settings out of the default-value assertions."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("XIAOMI_")}
    with patch.dict(os.environ, env, clear=True):
        yield


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("xiaomi/mimo-v2.6-pro", True),
        ("Xiaomi/mimo-v2.6-pro", True),
        ("mimo-v2.6-pro", True),
        ("mimo-v2.6-flash", True),
        ("mimo-v2.5-asr", True),
        ("anthropic/claude-sonnet-4-5-20250929", False),
        ("openai/gpt-5.4", False),
        ("opencode-go/mimo-v2.5", False),
        ("my-xiaomi/model", False),
    ],
)
def test_is_xiaomi_model(name, expected):
    assert is_xiaomi_model(name) is expected


def test_strip_xiaomi_prefix():
    assert strip_xiaomi_prefix("xiaomi/mimo-v2.6-pro") == "mimo-v2.6-pro"
    # Bare MiMo ids and non-Xiaomi names pass through untouched.
    assert strip_xiaomi_prefix("mimo-v2.6-pro") == "mimo-v2.6-pro"
    assert strip_xiaomi_prefix("openai/gpt-5.4") == "openai/gpt-5.4"


@pytest.mark.parametrize("name", ["xiaomi/mimo-v2.6-pro", "xiaomi/mimo-v2.6-flash", "mimo-v2.6-pro"])
def test_get_model_class_routes_xiaomi(name):
    assert get_model_class(name) is XiaomiModel


def test_explicit_model_class_wins_over_prefix():
    assert get_model_class("xiaomi/mimo-v2.6-pro", "litellm") is LitellmModel


def test_other_providers_are_unaffected():
    assert get_model_class("gemini/gemini-3-pro-preview") is LitellmModel
    assert get_model_class("opencode-go/mimo-v2.5") is not XiaomiModel


def test_xiaomi_model_defaults(clean_env):
    model = get_model("xiaomi/mimo-v2.6-pro")
    assert isinstance(model, XiaomiModel)
    # The xiaomi/ prefix is replaced by litellm's openai provider prefix.
    assert model.config.model_name == "openai/mimo-v2.6-pro"
    assert model.config.model_kwargs["custom_llm_provider"] == "openai"
    assert model.config.model_kwargs["api_base"] == DEFAULT_API_BASE == "https://token-plan-sgp.xiaomimimo.com/v1"
    assert model.config.model_kwargs["api_key"] == DEFAULT_API_KEY == ""
    assert model.config.model_kwargs["drop_params"] is True
    # The endpoint reports no per-token cost, so cost errors must not abort a run.
    assert model.config.cost_tracking == "ignore_errors"


def test_bare_model_id_is_served_verbatim(clean_env):
    """`mini -m mimo-v2.6-flash` must reach Xiaomi as exactly that id."""
    model = get_model("mimo-v2.6-flash")
    assert isinstance(model, XiaomiModel)
    assert model.config.model_name == "openai/mimo-v2.6-flash"


def test_xiaomi_model_respects_env_overrides(clean_env):
    with patch.dict(os.environ, {"XIAOMI_API_BASE": "https://example.com/v1/", "XIAOMI_API_KEY": "secret"}):
        model = get_model("xiaomi/mimo-v2.6-pro")
    assert model.config.model_kwargs["api_base"] == "https://example.com/v1"
    assert model.config.model_kwargs["api_key"] == "secret"


def test_explicit_model_kwargs_are_not_overridden(clean_env):
    model = get_model("xiaomi/mimo-v2.6-pro", {"model_kwargs": {"api_base": "https://custom/v1", "temperature": 0.3}})
    assert model.config.model_kwargs["api_base"] == "https://custom/v1"
    assert model.config.model_kwargs["temperature"] == 0.3
    # Defaults still fill in the gaps.
    assert model.config.model_kwargs["api_key"] == DEFAULT_API_KEY


def test_xiaomi_does_not_get_anthropic_cache_control(clean_env):
    model = get_model("xiaomi/mimo-v2.6-pro")
    assert model.config.set_cache_control is None
