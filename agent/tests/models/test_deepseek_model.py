import os
from unittest.mock import patch

import pytest

from minisweagent.models import get_model, get_model_class
from minisweagent.models.deepseek_model import (
    DEEPSEEK_MODEL_ALIASES,
    DEFAULT_API_BASE,
    DeepseekModel,
    _is_auth_error,
    _unsupported_model,
    is_deepseek_model,
    resolve_deepseek_alias,
    strip_deepseek_prefix,
)
from minisweagent.models.errors import ProviderAbortError, ProviderError


@pytest.fixture
def clean_env():
    """Keep the developer's DEEPSEEK_* settings out of the default-value assertions."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("DEEPSEEK_")}
    with patch.dict(os.environ, env, clear=True):
        yield


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("deepseek/deepseek-chat", True),
        ("DeepSeek/deepseek-chat", True),
        ("deepseek/deepseek-v3.2", True),
        ("deepseek-flash", True),
        ("deepseek-v4.1-flash", True),
        ("deepseek", True),
        ("anthropic/claude-sonnet-4-5-20250929", False),
        ("openai/gpt-5.4", False),
        ("deepseek-ai/DeepSeek-V3", False),
        ("my-deepseek/model", False),
    ],
)
def test_is_deepseek_model(name, expected):
    assert is_deepseek_model(name) is expected


def test_strip_deepseek_prefix():
    assert strip_deepseek_prefix("deepseek/deepseek-chat") == "deepseek-chat"
    # Non-deepseek names pass through untouched.
    assert strip_deepseek_prefix("openai/gpt-5.4") == "openai/gpt-5.4"


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        # The id DeepSeek markets is served by the API under the `v4` spelling.
        ("deepseek-v4.1-flash", "deepseek-v4-flash"),
        ("deepseek-v41-flash", "deepseek-v4-flash"),
        ("deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-flash"),
        # Non-aliases pass through untouched, prefix and case included.
        ("deepseek-chat", "deepseek-chat"),
        ("deepseek/deepseek-flash", "deepseek/deepseek-flash"),
        ("DeepSeek/DeepSeek-V3", "DeepSeek/DeepSeek-V3"),
        ("openai/gpt-5.4", "openai/gpt-5.4"),
    ],
)
def test_resolve_deepseek_alias(name, expected):
    assert resolve_deepseek_alias(name) == expected


def test_every_alias_resolves_to_itself_being_an_alias():
    """Guard against an alias pointing at another alias or at a typo."""
    for alias, target in DEEPSEEK_MODEL_ALIASES.items():
        assert alias != target
        assert target not in DEEPSEEK_MODEL_ALIASES


@pytest.mark.parametrize(
    "name",
    ["deepseek/deepseek-v41-flash", "deepseek-v41-flash", "deepseek/deepseek-v4.1-flash"],
)
def test_requested_alias_is_sent_as_the_served_id(name, clean_env):
    """`mini -m deepseek/deepseek-v41-flash` must not die on DeepSeek's first 400."""
    model = get_model(name)
    assert isinstance(model, DeepseekModel)
    assert model.requested_model_name == ("deepseek/" + name if "/" not in name else name)
    assert model.config.model_name == "deepseek/deepseek-v4-flash"


def test_alias_resolution_can_be_turned_off(clean_env):
    """DeepSeek-compatible endpoints own their id space, so allow passing ids verbatim."""
    model = get_model("deepseek/deepseek-v41-flash", {"resolve_aliases": False})
    assert model.requested_model_name == model.config.model_name == "deepseek/deepseek-v41-flash"


def test_non_alias_keeps_its_own_name(clean_env):
    model = get_model("deepseek/deepseek-chat")
    assert model.requested_model_name == model.config.model_name == "deepseek/deepseek-chat"


def test_get_model_class_routes_deepseek():
    assert get_model_class("deepseek/deepseek-chat") is DeepseekModel


def test_explicit_model_class_wins_over_prefix():
    pytest.importorskip("litellm")
    from minisweagent.models.litellm_model import LitellmModel

    assert get_model_class("deepseek/deepseek-chat", "litellm") is LitellmModel


def test_other_providers_are_unaffected():
    # Detached from litellm: unknown providers are generic OpenAI-compatible endpoints
    # (the litellm zoo is opt-in via `--model-class litellm`).
    from minisweagent.models.openai_compat_model import OpenaiCompatModel

    assert get_model_class("gemini/gemini-3-pro-preview") is OpenaiCompatModel


def test_deepseek_model_defaults(clean_env):
    model = get_model("deepseek/deepseek-chat")
    assert isinstance(model, DeepseekModel)
    # The deepseek/ prefix is kept: litellm uses it to select the provider and its prices.
    assert model.config.model_name == "deepseek/deepseek-chat"
    assert model.config.api_base == DEFAULT_API_BASE == "https://api.deepseek.com/v1"
    # DeepSeek ships ids litellm has no prices for, so a missing price entry must not abort a run.
    assert model.config.cost_tracking == "ignore_errors"


def test_bare_model_id_gets_provider_prefix(clean_env):
    assert get_model("deepseek-chat", {"model_class": "deepseek"}).config.model_name == "deepseek/deepseek-chat"


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("deepseek-flash", "deepseek/deepseek-flash"),
        ("deepseek-chat", "deepseek/deepseek-chat"),
        # An alias is routed *and* resolved to the id DeepSeek serves.
        ("deepseek-v4.1-flash", "deepseek/deepseek-v4-flash"),
    ],
)
def test_bare_ids_are_routed_to_the_profile(name, expected, clean_env):
    """`mini -m deepseek-flash` must work: litellm alone cannot infer the provider."""
    model = get_model(name)
    assert isinstance(model, DeepseekModel)
    assert model.config.model_name == expected


def test_provider_qualified_names_pass_through(clean_env):
    model = get_model("deepseek-ai/DeepSeek-V3", {"model_class": "deepseek"})
    assert model.config.model_name == "deepseek-ai/DeepSeek-V3"


def test_api_key_is_picked_up_from_env(clean_env):
    with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-test"}):
        model = get_model("deepseek/deepseek-chat")
    assert model.config.api_key == "sk-test"


def test_no_api_key_stays_unset(clean_env):
    model = get_model("deepseek/deepseek-chat")
    assert model.config.api_key == ""


def test_env_overrides_for_base_url(clean_env):
    with patch.dict(os.environ, {"DEEPSEEK_API_BASE": "http://example.com:8080/v1/", "DEEPSEEK_API_KEY": "sk-test"}):
        model = get_model("deepseek/deepseek-chat")
    assert model.config.api_base == "http://example.com:8080/v1"
    assert model.config.api_key == "sk-test"


def test_explicit_model_kwargs_are_not_overridden(clean_env):
    model = get_model(
        "deepseek/deepseek-chat",
        {"model_kwargs": {"api_base": "http://custom/v1", "api_key": "sk-mine", "temperature": 0.3}},
    )
    assert model.config.api_base == "http://custom/v1"
    assert model.config.api_key == "sk-mine"
    assert model.config.model_kwargs["temperature"] == 0.3


def test_explicit_cost_tracking_is_respected(clean_env):
    assert get_model("deepseek/deepseek-chat", {"cost_tracking": "default"}).config.cost_tracking == "default"


def test_deepseek_does_not_get_anthropic_cache_control(clean_env):
    assert get_model("deepseek/deepseek-chat").config.set_cache_control is None


def _bad_request(message: str) -> ProviderError:
    return ProviderError(message, 400)


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        (
            '{"error":{"message":"Authentication Fails, Your api key: ****-key is invalid","type":"authentication_error"}}',
            True,
        ),
        ("DeepseekException - Authentication Fails, Your api key is invalid", True),
        ("max_tokens is too large: 1000", False),
        ("model `deepseek/nope` not found", False),
    ],
)
def test_is_auth_error(message, expected):
    assert _is_auth_error(_bad_request(message)) is expected


def test_auth_errors_abort_instead_of_retrying():
    """DeepSeek reports bad keys as a 400, which would otherwise be retried forever."""
    assert ProviderAbortError in DeepseekModel.abort_exceptions


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        (
            "The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4.1-flash.",
            ("deepseek-flash, deepseek-v4-pro", "deepseek-v4.1-flash"),
        ),
        ("The supported API model names are deepseek-chat, but you passed nope.", ("deepseek-chat", "nope")),
        ("max_tokens is too large: 1000", None),
    ],
)
def test_unsupported_model(message, expected):
    assert _unsupported_model(_bad_request(message)) == expected
