import os
from unittest.mock import patch

import pytest

from minisweagent.models import get_model, get_model_class
from minisweagent.models.opencode_go_model import (
    ANTHROPIC_API_BASE,
    DEFAULT_API_BASE,
    DEFAULT_SESSION_HEADER,
    MODEL_BY_ID,
    OPENCODE_GO_MODELS,
    OpencodeGoModel,
    OpencodeGoResponseModel,
    endpoint_for,
    is_opencode_go_model,
    _ensure_pricing_registered,
    litellm_model_name,
    needs_messages_api,
    needs_responses_api,
    strip_opencode_go_prefix,
)


@pytest.fixture
def clean_env():
    """Keep the developer's OPENCODE_GO_* settings out of the default-value assertions."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("OPENCODE_GO_")}
    with patch.dict(os.environ, env, clear=True):
        yield


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("opencode-go/kimi-k3", True),
        ("OpenCode-Go/glm-5.3-flash", True),
        ("opencode-go/deepseek-v4-flash", True),
        ("anthropic/claude-sonnet-4-5-20250929", False),
        ("openai/gpt-5.4", False),
        ("deepseek/deepseek-chat", False),
        ("opencode/other-model", False),
        ("my-opencode-go/model", False),
    ],
)
def test_is_opencode_go_model(name, expected):
    assert is_opencode_go_model(name) is expected


def test_strip_opencode_go_prefix():
    assert strip_opencode_go_prefix("opencode-go/kimi-k3") == "kimi-k3"
    # Non-Go names pass through untouched.
    assert strip_opencode_go_prefix("openai/gpt-5.4") == "openai/gpt-5.4"


@pytest.mark.parametrize(
    "model_id",
    [model.id for model in OPENCODE_GO_MODELS],
)
def test_every_documented_model_is_routed(model_id):
    """All documented ids resolve to a known endpoint and a litellm provider prefix."""
    assert endpoint_for(model_id) in ("chat", "messages", "responses")
    assert litellm_model_name(model_id).split("/", 1)[0] in ("openai", "anthropic")


def test_endpoint_flavors_match_the_docs():
    assert endpoint_for("glm-5.3-flash") == "chat"
    assert endpoint_for("minimax-m3") == "messages"
    assert endpoint_for("grok-4.6") == "responses"
    # Undocumented ids fall back to the OpenAI compatible endpoint.
    assert endpoint_for("brand-new-model") == "chat"
    assert not needs_messages_api("brand-new-model")
    assert not needs_responses_api("brand-new-model")


def test_get_model_class_routes_opencode_go():
    assert get_model_class("opencode-go/glm-5.3-flash") is OpencodeGoModel
    assert get_model_class("opencode-go/minimax-m3") is OpencodeGoModel
    assert get_model_class("opencode-go/grok-4.6") is OpencodeGoResponseModel


def test_explicit_model_class_wins_over_prefix():
    pytest.importorskip("litellm")
    from minisweagent.models.litellm_model import LitellmModel

    assert get_model_class("opencode-go/grok-4.6", "litellm") is LitellmModel


def test_other_providers_are_unaffected():
    # Detached from litellm: unknown providers are generic OpenAI-compatible endpoints.
    from minisweagent.models.openai_compat_model import OpenaiCompatModel

    assert get_model_class("gemini/gemini-3-pro-preview") is OpenaiCompatModel


def test_model_defaults(clean_env):
    model = get_model("opencode-go/glm-5.3-flash")
    assert isinstance(model, OpencodeGoModel)
    # The wire id is bare (litellm's `openai/` provider names are gone).
    assert model.config.model_name == "glm-5.3-flash"
    assert model.config.api_base == DEFAULT_API_BASE == "https://opencode.ai/zen/go/v1"
    # Unknown ids report a cost of 0.0 instead of aborting a run.
    assert model.config.cost_tracking == "ignore_errors"


def test_anthropic_flavor_gets_the_messages_base(clean_env):
    """The client posts `/messages` after the base, which carries the `/v1` itself."""
    model = get_model("opencode-go/minimax-m3")
    assert isinstance(model, OpencodeGoModel)
    assert model.config.model_name == "minimax-m3"
    assert model.config.api_base == ANTHROPIC_API_BASE + "/v1" == "https://opencode.ai/zen/go/v1"


@pytest.mark.parametrize(
    ("model_id",),
    [("grok-4.6",), ("muse-spark-1.3-contributor",), ("muse-spark-1.2-contributor",)],
)
def test_responses_flavor_gets_the_response_model(clean_env, model_id):
    assert endpoint_for(model_id) == "responses"
    assert get_model_class(f"opencode-go/{model_id}") is OpencodeGoResponseModel
    from minisweagent.models.responses_compat_model import ResponsesCompatModel

    model = get_model(f"opencode-go/{model_id}")
    assert isinstance(model, OpencodeGoResponseModel)
    assert isinstance(model._impl, ResponsesCompatModel)
    assert model.config.model_name == model_id
    assert model.config.api_base == DEFAULT_API_BASE


def test_session_header_is_always_sent(clean_env):
    """The gateway answers `MissingSessionID` without it."""
    model = get_model("opencode-go/kimi-k3")
    assert model.config.model_kwargs["extra_headers"][DEFAULT_SESSION_HEADER]


def test_session_id_is_stable_and_env_overridable(clean_env):
    first = get_model("opencode-go/kimi-k3")
    assert first.config.model_kwargs["extra_headers"][DEFAULT_SESSION_HEADER]
    with patch.dict(os.environ, {"OPENCODE_GO_SESSION": "my-session"}):
        third = get_model("opencode-go/kimi-k3")
    assert third.config.model_kwargs["extra_headers"][DEFAULT_SESSION_HEADER] == "my-session"


def test_env_overrides_for_the_anthropic_flavor(clean_env):
    """Overriding the OpenAI base also moves the Anthropic base, unless it is set apart."""
    with patch.dict(os.environ, {"OPENCODE_GO_API_BASE": "http://example.com:8080/v1"}):
        assert get_model("opencode-go/minimax-m3").config.api_base == "http://example.com:8080/v1"
        assert get_model("opencode-go/kimi-k3").config.api_base == "http://example.com:8080/v1"
    with patch.dict(os.environ, {"OPENCODE_GO_ANTHROPIC_API_BASE": "http://anthropic-proxy/v1"}):
        assert get_model("opencode-go/minimax-m3").config.api_base == "http://anthropic-proxy/v1"


def test_explicit_headers_are_kept(clean_env):
    model = get_model(
        "opencode-go/kimi-k3",
        {"model_kwargs": {"extra_headers": {"x-opencode-session": "pinned", "x-other": "1"}}},
    )
    headers = model.config.model_kwargs["extra_headers"]
    assert headers["x-opencode-session"] == "pinned"
    assert headers["x-other"] == "1"


def test_api_key_is_picked_up_from_env(clean_env):
    with patch.dict(os.environ, {"OPENCODE_GO_API_KEY": "sk-test"}):
        model = get_model("opencode-go/kimi-k3")
    assert model.config.api_key == "sk-test"


def test_no_api_key_leaves_it_unset(clean_env):
    model = get_model("opencode-go/kimi-k3")
    assert model.config.api_key == ""


def test_env_overrides_for_base_url(clean_env):
    with patch.dict(
        os.environ, {"OPENCODE_GO_API_BASE": "http://example.com:8080/v1/", "OPENCODE_GO_API_KEY": "sk-test"}
    ):
        model = get_model("opencode-go/kimi-k3")
    assert model.config.api_base == "http://example.com:8080/v1"
    assert model.config.api_key == "sk-test"


def test_explicit_model_kwargs_are_not_overridden(clean_env):
    model = get_model(
        "opencode-go/kimi-k3",
        {"model_kwargs": {"api_base": "http://custom/v1", "api_key": "sk-mine", "temperature": 0.3}},
    )
    assert model.config.api_base == "http://custom/v1"
    assert model.config.api_key == "sk-mine"
    assert model.config.model_kwargs["temperature"] == 0.3


def test_explicit_cost_tracking_is_respected(clean_env):
    assert get_model("opencode-go/kimi-k3", {"cost_tracking": "default"}).config.cost_tracking == "default"


def test_opencode_go_does_not_get_anthropic_cache_control(clean_env):
    assert get_model("opencode-go/kimi-k3").config.set_cache_control is None
    assert get_model("opencode-go/minimax-m3").config.set_cache_control is None


def test_registry_covers_every_model_and_its_prices():
    """The documented prices land in `models.prices`, so `--cost-limit` works for these ids."""
    from minisweagent.models import prices

    _ensure_pricing_registered()
    for model in OPENCODE_GO_MODELS:
        price = prices.price_for("opencode-go", model.id)
        assert price is not None
        assert price.input == pytest.approx(model.input)
        assert price.output == pytest.approx(model.output)
        assert price.cache_read == pytest.approx(model.cache_read)
        assert price.cache_write == pytest.approx(model.cache_write)


def test_tiered_models_declare_both_tiers():
    from minisweagent.models import prices

    _ensure_pricing_registered()
    price = prices.price_for("opencode-go", "grok-4.6")
    assert price.tier_threshold == 200000
    assert price.tier_input == pytest.approx(4.0)
    assert MODEL_BY_ID["qwen3.7-plus"].tiered
    assert not MODEL_BY_ID["kimi-k3"].tiered
    assert MODEL_BY_ID["union-alpha"].free


def test_ids_missing_from_the_docs_table_are_still_usable(clean_env):
    model = get_model("opencode-go/brand-new-model")
    assert isinstance(model, OpencodeGoModel)
    assert model.config.model_name == "brand-new-model"
    assert model.config.api_base == DEFAULT_API_BASE
