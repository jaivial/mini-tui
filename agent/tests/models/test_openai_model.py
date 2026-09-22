import os
from unittest.mock import patch

import pytest

from minisweagent.models import get_model, get_model_class
from minisweagent.models.litellm_model import LitellmModel
from minisweagent.models.openai_model import (
    DEFAULT_API_BASE,
    OpenaiModel,
    is_openai_model,
    needs_responses_api,
    strip_openai_prefix,
)


@pytest.fixture
def clean_env():
    """Keep the developer's OPENAI_* settings out of the default-value assertions."""
    env = {k: v for k, v in os.environ.items() if not (k.startswith("OPENAI_") or k.startswith("MSWEA_OPENAI_"))}
    with patch.dict(os.environ, env, clear=True):
        yield


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("openai/gpt-5.4", True),
        ("OpenAI/gpt-5.4", True),
        ("openai/gpt-4o", True),
        ("openai/o3-mini", True),
        ("anthropic/claude-sonnet-4-5-20250929", False),
        ("gpt-5.4", False),
        ("my-openai/model", False),
    ],
)
def test_is_openai_model(name, expected):
    assert is_openai_model(name) is expected


def test_strip_openai_prefix():
    assert strip_openai_prefix("openai/gpt-5.4") == "gpt-5.4"
    # Non-openai names pass through untouched.
    assert strip_openai_prefix("anthropic/claude-sonnet-4-5") == "anthropic/claude-sonnet-4-5"


def test_get_model_class_routes_openai():
    assert get_model_class("openai/gpt-5.4") is OpenaiModel


def test_explicit_model_class_wins_over_prefix():
    assert get_model_class("openai/gpt-5.4", "litellm") is LitellmModel


def test_other_providers_are_unaffected():
    assert get_model_class("anthropic/claude-sonnet-4-5") is LitellmModel


def test_openai_model_defaults(clean_env):
    model = get_model("openai/gpt-5.4")
    assert isinstance(model, OpenaiModel)
    # The openai/ prefix is kept: litellm uses it to select the provider and its prices.
    assert model.config.model_name == "openai/gpt-5.4"
    assert model.config.model_kwargs["api_base"] == DEFAULT_API_BASE == "https://api.openai.com/v1"
    assert model.config.model_kwargs["drop_params"] is True
    # OpenAI ships ids litellm has no prices for, so a missing price entry must not abort a run.
    assert model.config.cost_tracking == "ignore_errors"


def test_api_key_is_picked_up_from_env(clean_env):
    with patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test"}):
        model = get_model("openai/gpt-5.4")
    assert model.config.model_kwargs["api_key"] == "sk-test"


def test_no_api_key_leaves_it_to_litellm(clean_env):
    model = get_model("openai/gpt-5.4")
    assert "api_key" not in model.config.model_kwargs


def test_env_overrides_for_base_url(clean_env):
    with patch.dict(os.environ, {"OPENAI_API_BASE": "http://example.com:8080/v1/", "OPENAI_API_KEY": "sk-test"}):
        model = get_model("openai/gpt-5.4")
    assert model.config.model_kwargs["api_base"] == "http://example.com:8080/v1"
    assert model.config.model_kwargs["api_key"] == "sk-test"


def test_explicit_model_kwargs_are_not_overridden(clean_env):
    model = get_model(
        "openai/gpt-5.4",
        {"model_kwargs": {"api_base": "http://custom/v1", "api_key": "sk-mine", "temperature": 0.3}},
    )
    assert model.config.model_kwargs["api_base"] == "http://custom/v1"
    assert model.config.model_kwargs["api_key"] == "sk-mine"
    assert model.config.model_kwargs["temperature"] == 0.3


def test_explicit_cost_tracking_is_respected(clean_env):
    assert get_model("openai/gpt-5.4", {"cost_tracking": "default"}).config.cost_tracking == "default"


def test_openai_does_not_get_anthropic_cache_control(clean_env):
    assert get_model("openai/gpt-5.4").config.set_cache_control is None


def test_mswa_prefixed_env_wins_over_openai_env(clean_env):
    """Other tools export OPENAI_* for their own gateway; MSWEA_OPENAI_* must win."""
    with patch.dict(
        os.environ,
        {
            "OPENAI_API_KEY": "gateway-key",
            "OPENAI_API_BASE": "http://127.0.0.1:9120/v1",
            "MSWEA_OPENAI_API_KEY": "sk-real",
            "MSWEA_OPENAI_API_BASE": "https://api.openai.com/v1/",
        },
    ):
        model = get_model("openai/gpt-5.4")
    assert model.config.model_kwargs["api_key"] == "sk-real"
    assert model.config.model_kwargs["api_base"] == "https://api.openai.com/v1"


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("openai/gpt-6-astra", True),
        ("gpt-6-astra", True),
        ("openai/gpt-6", True),
        ("openai/gpt-6.1", True),
        ("openai/gpt-5.4", False),
        ("openai/gpt-4o", False),
        ("openai/gpt-6x", False),
    ],
)
def test_needs_responses_api(name, expected):
    assert needs_responses_api(name) is expected


def test_get_model_class_routes_responses_only_models():
    from minisweagent.models.openai_model import OpenaiResponseModel

    assert get_model_class("openai/gpt-6-astra") is OpenaiResponseModel


def test_responses_model_defaults(clean_env):
    from minisweagent.models.openai_model import OpenaiResponseModel

    model = get_model("openai/gpt-6-astra")
    assert isinstance(model, OpenaiResponseModel)
    assert model.config.model_name == "openai/gpt-6-astra"
    assert model.config.model_kwargs["api_base"] == DEFAULT_API_BASE == "https://api.openai.com/v1"
    assert model.config.cost_tracking == "ignore_errors"


def test_responses_model_honours_mswa_env(clean_env):
    with patch.dict(os.environ, {"MSWEA_OPENAI_API_KEY": "sk-real"}):
        model = get_model("openai/gpt-6-astra")
    assert model.config.model_kwargs["api_key"] == "sk-real"


def test_temperature_rejection_is_retried_without_temperature(clean_env):
    """gpt-6-astra rejects a configured temperature; the model must strip it and retry."""
    import litellm

    model = get_model("openai/gpt-6-astra", {"model_kwargs": {"temperature": 0.0}})
    calls = {"n": 0}

    def fake_super_query(self, messages, **kwargs):
        calls["n"] += 1
        if "temperature" in model.config.model_kwargs:
            raise litellm.exceptions.BadRequestError(
                "Unsupported value: 'temperature' does not support 0.0 with this model. "
                "Only the default (1) value is supported.",
                model="openai/gpt-6-astra",
                llm_provider="openai",
            )
        return "ok"

    with patch.object(type(model).__mro__[2], "_query", fake_super_query):
        assert model._query([{"role": "user", "content": "hi"}]) == "ok"
    assert calls["n"] == 2
    assert "temperature" not in model.config.model_kwargs


def test_unrelated_bad_request_is_not_retried(clean_env):
    import litellm

    model = get_model("openai/gpt-5.4", {"model_kwargs": {"temperature": 0.0}})

    def fake_super_query(self, messages, **kwargs):
        raise litellm.exceptions.BadRequestError("some other problem", model="openai/gpt-5.4", llm_provider="openai")

    with patch.object(type(model).__mro__[2], "_query", fake_super_query):
        with pytest.raises(litellm.exceptions.BadRequestError):
            model._query([{"role": "user", "content": "hi"}])
    # The unrelated error must not drop the user's temperature setting.
    assert model.config.model_kwargs["temperature"] == 0.0
