"""OpenCode Go (`opencode.ai/zen/go`) support for mini-swe-agent.

[OpenCode Go](https://opencode.ai/docs/go/) is a low cost subscription that gives
stable access to a curated set of open coding models. Go serves those models
through one gateway and three endpoint flavors:

* `/chat/completions` - OpenAI compatible (GLM, Kimi, DeepSeek, MiMo, LongCat, Hy, ...)
* `/messages` - Anthropic compatible (MiniMax, Qwen, Union Alpha)
* `/responses` - OpenAI Responses API (Grok 4.6, GPT 5.6 Luna, Muse Spark)

Usage:

    mini -m opencode-go/glm-5.3-flash
    mini -m opencode-go/kimi-k3
    mini -m opencode-go/minimax-m3       # Anthropic compatible endpoint, picked automatically
    mini -m opencode-go/grok-4.6         # Responses API endpoint, picked automatically

The `opencode-go/` prefix routes the id to the endpoint the gateway documents for it
(see the `Endpoints` table at https://opencode.ai/docs/go/#endpoints) and is stripped
before the request goes upstream.

Configuration (environment variables or `mini-extra config set KEY VALUE`):

    OPENCODE_GO_API_KEY     default: (empty)
    OPENCODE_GO_API_BASE    default: https://opencode.ai/zen/go/v1
    OPENCODE_GO_SESSION     default: (random id, generated once per run)

OpenCode Go refuses requests without a stable `x-opencode-session` header
(`MissingSessionID`), so every request this module sends carries one. Set
`OPENCODE_GO_SESSION` to reuse the same routing/prompt-cache bucket across runs.

Run `mini-extra opencode-go-models` to list the ids your key can use together with
the endpoint and the documented prices.
"""

import logging
import os
import re
import uuid
from dataclasses import dataclass
from typing import Any, Literal

import litellm

from minisweagent.models.litellm_model import LitellmModel, LitellmModelConfig
from minisweagent.models.litellm_response_model import LitellmResponseModel

logger = logging.getLogger(__name__)

#: Prefix used to route a model name to OpenCode Go.
OPENCODE_GO_PREFIX = "opencode-go/"

#: Base URL for the OpenAI compatible flavors (`/chat/completions`, `/responses`).
DEFAULT_API_BASE = "https://opencode.ai/zen/go/v1"

#: Base URL for the Anthropic compatible `/v1/messages` flavor.
ANTHROPIC_API_BASE = "https://opencode.ai/zen/go"

DEFAULT_API_KEY = ""
"""litellm picks up nothing for this provider, so an unset key fails on the first call."""

DEFAULT_SESSION_HEADER = "x-opencode-session"

#: Endpoint flavors the Go gateway serves.
Endpoint = Literal["chat", "messages", "responses"]


@dataclass(frozen=True)
class GoModelInfo:
    """Metadata for one OpenCode Go model (docs: prices + `Endpoints` table)."""

    id: str
    """Model id as the gateway expects it, e.g. `glm-5.3-flash`."""
    name: str
    """Human readable name from the docs."""
    endpoint: Endpoint
    """Which of the three Go endpoint flavors serves this model."""
    input: float
    """Documented input price in $/1M tokens."""
    output: float
    """Documented output price in $/1M tokens."""
    cache_read: float
    """Documented cache read price in $/1M tokens (0 when the docs print `-`)."""
    cache_write: float
    """Documented cache write price in $/1M tokens (0 when the docs print `-`)."""
    monthly_limit: int
    """Included monthly budget in $ (0 marks the free-for-now models)."""
    tier_threshold: int | None = None
    """Input token count above which the second price tier applies, if the model has one."""
    tier_input: float = 0.0
    tier_output: float = 0.0
    tier_cache_read: float = 0.0
    tier_cache_write: float = 0.0
    context_window: int = 128000
    max_tokens: int = 16384
    reasoning: bool = False
    input_modalities: tuple[str, ...] = ("text",)

    @property
    def free(self) -> bool:
        """Whether the model is advertised as free (Union Alpha, limited time)."""
        return self.input == 0 and self.output == 0

    @property
    def tiered(self) -> bool:
        """Whether the docs list a second price tier above `tier_threshold`."""
        return self.tier_threshold is not None


#: Every model OpenCode Go advertises in the `Endpoints` table of
#: https://opencode.ai/docs/go/#endpoints (anchor `#limites-de-uso` holds the prices).
#:
#: ``endpoint`` is the path the model is served on:
#:
#: * ``chat``      -> ``https://opencode.ai/zen/go/v1/chat/completions`` (OpenAI compatible)
#: * ``messages``  -> ``https://opencode.ai/zen/go/v1/messages`` (Anthropic compatible)
#: * ``responses`` -> ``https://opencode.ai/zen/go/v1/responses`` (OpenAI Responses API)
#:
#: ``input``/``output``/``cache_read``/``cache_write`` are the documented prices in US dollars
#: per million tokens, and ``monthly_limit`` is the included monthly budget in US dollars
#: (0 marks the models that are free while the promotion lasts). Prices marked as Off-Peak in
#: the docs are used verbatim; the Off-Peak hours are 01:00-04:00 and 06:00-10:00 UTC on weekdays.
OPENCODE_GO_MODELS: tuple[GoModelInfo, ...] = (
    GoModelInfo(
        id="grok-4.6",
        name="Grok 4.6",
        endpoint="responses",
        input=2.0,
        output=6.0,
        cache_read=0.5,
        cache_write=0.0,
        monthly_limit=15,
        tier_threshold=200000,
        tier_input=4.0,
        tier_output=12.0,
        tier_cache_read=1.0,
        tier_cache_write=0.0,
        context_window=500000,
        max_tokens=500000,
        reasoning=True,
        input_modalities=("text", "image"),
    ),
    GoModelInfo(
        id="gpt-5.6-luna",
        name="GPT 5.6 Luna",
        endpoint="responses",
        input=0.2,
        output=1.2,
        cache_read=0.02,
        cache_write=0.25,
        monthly_limit=15,
        tier_threshold=272000,
        tier_input=0.4,
        tier_output=1.8,
        tier_cache_read=0.04,
        tier_cache_write=0.5,
        context_window=1050000,
        max_tokens=128000,
        reasoning=True,
        input_modalities=("text", "image"),
    ),
    GoModelInfo(
        id="glm-5.3-flash",
        name="GLM-5.3-Flash",
        endpoint="chat",
        input=0.15,
        output=0.5,
        cache_read=0.03,
        cache_write=0.0,
        monthly_limit=60,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=1000000,
        max_tokens=131072,
        reasoning=True,
        input_modalities=("text", "image"),
    ),
    GoModelInfo(
        id="glm-5.3",
        name="GLM-5.3",
        endpoint="chat",
        input=1.4,
        output=4.4,
        cache_read=0.26,
        cache_write=0.0,
        monthly_limit=15,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=1000000,
        max_tokens=131072,
        reasoning=True,
        input_modalities=("text",),
    ),
    GoModelInfo(
        id="glm-5.2",
        name="GLM-5.2",
        endpoint="chat",
        input=1.4,
        output=4.4,
        cache_read=0.26,
        cache_write=0.0,
        monthly_limit=60,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=1000000,
        max_tokens=131072,
        reasoning=True,
        input_modalities=("text",),
    ),
    GoModelInfo(
        id="glm-5.1",
        name="GLM-5.1",
        endpoint="chat",
        input=1.4,
        output=4.4,
        cache_read=0.26,
        cache_write=0.0,
        monthly_limit=60,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=202752,
        max_tokens=32768,
        reasoning=True,
        input_modalities=("text",),
    ),
    GoModelInfo(
        id="kimi-k3",
        name="Kimi K3",
        endpoint="chat",
        input=3.0,
        output=15.0,
        cache_read=0.3,
        cache_write=0.0,
        monthly_limit=15,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=1048576,
        max_tokens=131072,
        reasoning=True,
        input_modalities=("text", "image"),
    ),
    GoModelInfo(
        id="kimi-k2.7-code",
        name="Kimi K2.7 Code",
        endpoint="chat",
        input=0.95,
        output=4.0,
        cache_read=0.19,
        cache_write=0.0,
        monthly_limit=60,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=262144,
        max_tokens=262144,
        reasoning=True,
        input_modalities=("text", "image"),
    ),
    GoModelInfo(
        id="kimi-k2.6",
        name="Kimi K2.6",
        endpoint="chat",
        input=0.95,
        output=4.0,
        cache_read=0.16,
        cache_write=0.0,
        monthly_limit=60,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=262144,
        max_tokens=65536,
        reasoning=True,
        input_modalities=("text", "image"),
    ),
    GoModelInfo(
        id="longcat-2.0",
        name="LongCat-2.0",
        endpoint="chat",
        input=0.3,
        output=1.2,
        cache_read=0.006,
        cache_write=0.0,
        monthly_limit=60,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=1000000,
        max_tokens=131072,
        reasoning=True,
        input_modalities=("text",),
    ),
    GoModelInfo(
        id="deepseek-v4.1-flash",
        name="DeepSeek V4.1 Flash",
        endpoint="chat",
        input=0.15,
        output=0.6,
        cache_read=0.003,
        cache_write=0.0,
        monthly_limit=60,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=1000000,
        max_tokens=384000,
        reasoning=True,
        input_modalities=("text",),
    ),
    GoModelInfo(
        id="deepseek-v4-pro",
        name="DeepSeek V4 Pro",
        endpoint="chat",
        input=0.66,
        output=1.98,
        cache_read=0.022,
        cache_write=0.0,
        monthly_limit=15,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=1000000,
        max_tokens=384000,
        reasoning=True,
        input_modalities=("text",),
    ),
    GoModelInfo(
        id="deepseek-v4-flash",
        name="DeepSeek V4 Flash",
        endpoint="chat",
        input=0.15,
        output=0.6,
        cache_read=0.003,
        cache_write=0.0,
        monthly_limit=30,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=1000000,
        max_tokens=384000,
        reasoning=True,
        input_modalities=("text",),
    ),
    GoModelInfo(
        id="deepseek-v4-flash-vision-exp",
        name="DeepSeek V4 Flash Vision Exp",
        endpoint="chat",
        input=0.15,
        output=0.6,
        cache_read=0.003,
        cache_write=0.0,
        monthly_limit=15,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=1000000,
        max_tokens=384000,
        reasoning=True,
        input_modalities=("text", "image"),
    ),
    GoModelInfo(
        id="mimo-v2.5",
        name="MiMo-V2.5",
        endpoint="chat",
        input=0.14,
        output=0.28,
        cache_read=0.0028,
        cache_write=0.0,
        monthly_limit=60,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=1000000,
        max_tokens=128000,
        reasoning=True,
        input_modalities=("text", "image"),
    ),
    GoModelInfo(
        id="mimo-v2.5-pro",
        name="MiMo-V2.5-Pro",
        endpoint="chat",
        input=0.435,
        output=0.87,
        cache_read=0.003625,
        cache_write=0.0,
        monthly_limit=15,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=1048576,
        max_tokens=128000,
        reasoning=True,
        input_modalities=("text",),
    ),
    GoModelInfo(
        id="minimax-m3",
        name="MiniMax M3",
        endpoint="messages",
        input=0.3,
        output=1.2,
        cache_read=0.06,
        cache_write=0.0,
        monthly_limit=60,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=1000000,
        max_tokens=131072,
        reasoning=True,
        input_modalities=("text", "image"),
    ),
    GoModelInfo(
        id="minimax-m2.7",
        name="MiniMax M2.7",
        endpoint="messages",
        input=0.3,
        output=1.2,
        cache_read=0.06,
        cache_write=0.375,
        monthly_limit=60,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=204800,
        max_tokens=131072,
        reasoning=True,
        input_modalities=("text",),
    ),
    GoModelInfo(
        id="minimax-m2.5",
        name="MiniMax M2.5",
        endpoint="messages",
        input=0.3,
        output=1.2,
        cache_read=0.06,
        cache_write=0.375,
        monthly_limit=60,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=204800,
        max_tokens=131072,
        reasoning=True,
        input_modalities=("text",),
    ),
    GoModelInfo(
        id="muse-spark-1.3-contributor",
        name="Muse Spark 1.3 Contributor",
        endpoint="responses",
        input=0.1,
        output=0.2,
        cache_read=0.002,
        cache_write=0.0,
        monthly_limit=60,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=1048576,
        max_tokens=131072,
        reasoning=True,
        input_modalities=("text", "image"),
    ),
    GoModelInfo(
        id="muse-spark-1.2-contributor",
        name="Muse Spark 1.2 Contributor",
        endpoint="responses",
        input=0.1,
        output=0.2,
        cache_read=0.002,
        cache_write=0.0,
        monthly_limit=60,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=1048576,
        max_tokens=131072,
        reasoning=True,
        input_modalities=("text", "image"),
    ),
    GoModelInfo(
        id="qwen3.8-max",
        name="Qwen3.8 Max",
        endpoint="messages",
        input=2.0,
        output=6.0,
        cache_read=0.25,
        cache_write=2.5,
        monthly_limit=15,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=1000000,
        max_tokens=131072,
        reasoning=True,
        input_modalities=("text", "image"),
    ),
    GoModelInfo(
        id="qwen3.8-flash",
        name="Qwen3.8 Flash",
        endpoint="messages",
        input=0.15,
        output=0.47,
        cache_read=0.016,
        cache_write=0.2,
        monthly_limit=30,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=1000000,
        max_tokens=131072,
        reasoning=True,
        input_modalities=("text", "image"),
    ),
    GoModelInfo(
        id="qwen3.7-max",
        name="Qwen3.7 Max",
        endpoint="messages",
        input=2.5,
        output=7.5,
        cache_read=0.5,
        cache_write=3.125,
        monthly_limit=30,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=1000000,
        max_tokens=65536,
        reasoning=True,
        input_modalities=("text",),
    ),
    GoModelInfo(
        id="qwen3.7-plus",
        name="Qwen3.7 Plus",
        endpoint="messages",
        input=0.4,
        output=1.6,
        cache_read=0.04,
        cache_write=0.5,
        monthly_limit=60,
        tier_threshold=256000,
        tier_input=1.2,
        tier_output=4.8,
        tier_cache_read=0.12,
        tier_cache_write=1.5,
        context_window=1000000,
        max_tokens=65536,
        reasoning=True,
        input_modalities=("text", "image"),
    ),
    GoModelInfo(
        id="qwen3.6-plus",
        name="Qwen3.6 Plus",
        endpoint="messages",
        input=0.5,
        output=3.0,
        cache_read=0.05,
        cache_write=0.625,
        monthly_limit=60,
        tier_threshold=256000,
        tier_input=2.0,
        tier_output=6.0,
        tier_cache_read=0.2,
        tier_cache_write=2.5,
        context_window=1000000,
        max_tokens=65536,
        reasoning=True,
        input_modalities=("text", "image"),
    ),
    GoModelInfo(
        id="hy4-preview",
        name="Hy4 preview",
        endpoint="chat",
        input=0.834,
        output=2.501,
        cache_read=0.042,
        cache_write=0.0,
        monthly_limit=30,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=1024000,
        max_tokens=64000,
        reasoning=True,
        input_modalities=("text",),
    ),
    GoModelInfo(
        id="hy3",
        name="Hy3",
        endpoint="chat",
        input=0.14,
        output=0.58,
        cache_read=0.035,
        cache_write=0.0,
        monthly_limit=60,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=256000,
        max_tokens=128000,
        reasoning=True,
        input_modalities=("text",),
    ),
    GoModelInfo(
        id="union-alpha",
        name="Union Alpha Free",
        endpoint="messages",
        input=0.0,
        output=0.0,
        cache_read=0.0,
        cache_write=0.0,
        monthly_limit=0,
        tier_threshold=None,
        tier_input=0,
        tier_output=0,
        tier_cache_read=0,
        tier_cache_write=0,
        context_window=500000,
        max_tokens=128000,
        reasoning=True,
        input_modalities=("text", "image"),
    ),
)


#: Every advertised id, indexed for lookups.
MODEL_BY_ID: dict[str, GoModelInfo] = {model.id: model for model in OPENCODE_GO_MODELS}


def is_opencode_go_model(model_name: str) -> bool:
    """Whether `model_name` should be served by OpenCode Go."""
    return model_name.lower().startswith(OPENCODE_GO_PREFIX)


def strip_opencode_go_prefix(model_name: str) -> str:
    """Remove the `opencode-go/` routing prefix from a model name."""
    if is_opencode_go_model(model_name):
        return model_name[len(OPENCODE_GO_PREFIX) :]
    return model_name


def get_model_info(model_id: str) -> GoModelInfo | None:
    """Metadata for a Go id, or `None` for ids the docs do not list (yet)."""
    return MODEL_BY_ID.get(strip_opencode_go_prefix(model_id).lower())


def endpoint_for(model_id: str) -> Endpoint:
    """Endpoint flavor the Go gateway documents for `model_id` (unknown ids: `chat`)."""
    info = get_model_info(model_id)
    return info.endpoint if info else "chat"


def needs_messages_api(model_id: str) -> bool:
    """Whether `model_id` is served through the Anthropic compatible `/messages` endpoint."""
    return endpoint_for(model_id) == "messages"


def needs_responses_api(model_id: str) -> bool:
    """Whether `model_id` is served through the OpenAI `/responses` endpoint."""
    return endpoint_for(model_id) == "responses"


def litellm_model_name(model_id: str) -> str:
    """litellm provider-qualified name for a Go id.

    The Anthropic compatible endpoint needs litellm's `anthropic` provider (for the
    `x-api-key` header and the `/v1/messages` path), everything else speaks the OpenAI
    protocol and goes through the `openai` provider.
    """
    model_id = strip_opencode_go_prefix(model_id)
    return f"anthropic/{model_id}" if needs_messages_api(model_id) else f"openai/{model_id}"


def openai_api_base() -> str:
    """Base URL for the OpenAI compatible flavors, overridable through `OPENCODE_GO_API_BASE`."""
    return os.getenv("OPENCODE_GO_API_BASE", DEFAULT_API_BASE).rstrip("/")


def anthropic_api_base() -> str:
    """Base URL for the Anthropic compatible flavor (litellm appends `/v1/messages`)."""
    override = os.getenv("OPENCODE_GO_ANTHROPIC_API_BASE")
    if override:
        return override.rstrip("/")
    base = openai_api_base()
    return base[: -len("/v1")] if base.endswith("/v1") else base


def _session_id() -> str:
    """Stable per-run session id for the mandatory `x-opencode-session` header."""
    return os.getenv("OPENCODE_GO_SESSION") or f"mini-swe-agent-{uuid.uuid4().hex[:16]}"


def _with_session_headers(model_kwargs: dict[str, Any]) -> dict[str, Any]:
    """Add the session/attribution headers the Go gateway asks for, keeping explicit ones."""
    headers = dict(model_kwargs.get("extra_headers") or {})
    headers.setdefault(DEFAULT_SESSION_HEADER, _session_id())
    headers.setdefault("x-opencode-client", "mini-swe-agent")
    model_kwargs["extra_headers"] = headers
    return model_kwargs


def _litellm_registry() -> dict[str, dict[str, Any]]:
    """litellm model registry entries carrying the documented Go prices.

    litellm does not know these ids, so without this every response would be costed at
    0.0 and `--cost-limit` would never trip. Tiered models (Grok 4.6, GPT 5.6 Luna,
    Qwen Plus) use litellm's `tiered_pricing` table, which picks one tier per request
    from the input token count, exactly like the docs bill them.
    """
    registry: dict[str, dict[str, Any]] = {}
    for model in OPENCODE_GO_MODELS:
        entry: dict[str, Any] = {
            "input_cost_per_token": model.input / 1e6,
            "output_cost_per_token": model.output / 1e6,
            "cache_read_input_token_cost": model.cache_read / 1e6,
            "cache_creation_input_token_cost": model.cache_write / 1e6,
            "litellm_provider": "anthropic" if model.endpoint == "messages" else "openai",
            "mode": "chat",
        }
        if model.tiered:
            base = {
                "input_cost_per_token": model.input / 1e6,
                "output_cost_per_token": model.output / 1e6,
                "cache_read_input_token_cost": model.cache_read / 1e6,
                "cache_creation_input_token_cost": model.cache_write / 1e6,
            }
            upper = {
                "input_cost_per_token": model.tier_input / 1e6,
                "output_cost_per_token": model.tier_output / 1e6,
                "cache_read_input_token_cost": model.tier_cache_read / 1e6,
                "cache_creation_input_token_cost": model.tier_cache_write / 1e6,
            }
            entry["tiered_pricing"] = [
                dict(base, range=[0, model.tier_threshold]),
                dict(upper, range=[model.tier_threshold, 10**12]),
            ]
        # litellm looks prices up under the provider-qualified name we send.
        prefix = "anthropic/" if model.endpoint == "messages" else "openai/"
        registry[f"{prefix}{model.id}"] = entry
    return registry


_REGISTRY_REGISTERED = False


def _ensure_pricing_registered() -> None:
    """Register the Go prices with litellm once per process."""
    global _REGISTRY_REGISTERED
    if _REGISTRY_REGISTERED:
        return
    litellm.utils.register_model(_litellm_registry())
    _REGISTRY_REGISTERED = True


def _is_missing_session_error(exception: Exception) -> bool:
    """Whether the gateway rejected the request because of a missing session header."""
    return "MissingSessionID" in str(exception) or "x-opencode-session" in str(exception).lower()


#: Ids whose backend requires `reasoning_content` back on assistant messages from
#: turn 2 on (pi catalog: `thinkingFormat: deepseek/qwen`,
#: `requiresReasoningContentOnAssistantMessages: true`). litellm keeps unknown
#: message keys, so `_prepare_messages_for_api` only has to not strip them.
REASONING_CONTENT_MODELS = frozenset(
    {
        "deepseek-v4-flash",
        "deepseek-v4-pro",
        "deepseek-v4.1-flash",
        "deepseek-v4-flash-vision-exp",
        "kimi-k2.6",
        "qwen3.6-plus",
    }
)

#: Ids rejecting `reasoning_effort` (pi catalog: `supportsReasoningEffort: false`).
NO_REASONING_EFFORT_MODELS = frozenset({"kimi-k2.6"})

#: Sampling params some Go backends reject; on rejection the param is stripped and
#: the request retried once (same idea as `OpenaiModel`'s temperature fallback).
_SAMPLING_PARAMS = ("temperature", "reasoning_effort", "top_p", "top_k", "response_format")
_SAMPLING_ERROR_RE = re.compile(
    r"(temperature|reasoning_effort|response_format|top_p|top_k).{0,80}"
    r"(not supported|unsupported|does not support|not allowed)",
    re.IGNORECASE | re.DOTALL,
)

_UNKNOWN_MODEL_RE = re.compile(
    r"(model.{0,80}(not found|unknown|unsupported|does not exist|not available)|unknown model|invalid model)",
    re.IGNORECASE | re.DOTALL,
)

_AUTH_ERROR_RE = re.compile(
    r"(invalid api key|incorrect api key|invalid_token|unauthorized|authentication fail|bearer)",
    re.IGNORECASE,
)


def _strip_rejected_sampling_param(model_kwargs: dict[str, Any], exception: Exception) -> str | None:
    """Pop the sampling param the backend rejected. Returns its name, else `None`."""
    if not _SAMPLING_ERROR_RE.search(str(exception)):
        return None
    lowered = str(exception).lower()
    for param in _SAMPLING_PARAMS:
        if param in lowered and param in model_kwargs:
            model_kwargs.pop(param, None)
            return param
    return None


def _resolve_api_key() -> str:
    """API key, `MSWEA_` first so other tools' `OPENCODE_API_KEY` cannot shadow it."""
    return (
        os.getenv("MSWEA_OPENCODE_GO_API_KEY")
        or os.getenv("OPENCODE_GO_API_KEY", DEFAULT_API_KEY)
        or os.getenv("OPENCODE_API_KEY", "")
    )


def _normalize_model_kwargs(model_id: str, model_kwargs: dict[str, Any]) -> dict[str, Any]:
    """Coerce kwargs to what the Go gateway accepts (cf. pi's per-model `compat`)."""
    model_kwargs = dict(model_kwargs)
    # The gateway speaks `max_tokens`, never `max_completion_tokens`.
    if "max_completion_tokens" in model_kwargs and "max_tokens" not in model_kwargs:
        model_kwargs["max_tokens"] = model_kwargs.pop("max_completion_tokens")
    # No Go model in pi's catalog sets `supportsStore`.
    model_kwargs.pop("store", None)
    if strip_opencode_go_prefix(model_id).lower() in NO_REASONING_EFFORT_MODELS:
        model_kwargs.pop("reasoning_effort", None)
    if not needs_responses_api(model_id):
        # The agent loop only progresses on tool calls; require one every turn.
        model_kwargs.setdefault("tool_choice", "required")
        model_kwargs.setdefault("parallel_tool_calls", False)
    return model_kwargs


class OpencodeGoModelConfig(LitellmModelConfig):
    model_kwargs: dict[str, Any] = {}
    cost_tracking: Literal["default", "ignore_errors"] = os.getenv("MSWEA_COST_TRACKING", "ignore_errors")
    """Prices ship with this module, but a docs refresh can still lag behind a new id;
    unknown ids then report a cost of 0.0 instead of aborting the run."""


class OpencodeGoModel(LitellmModel):
    """Talks to OpenCode Go, picking the endpoint the gateway documents for the id."""

    def __init__(self, **kwargs):
        kwargs.setdefault("config_class", OpencodeGoModelConfig)
        super().__init__(**kwargs)
        _ensure_pricing_registered()

        model_id = strip_opencode_go_prefix(self.config.model_name)
        self.config.model_name = litellm_model_name(model_id)
        if get_model_info(model_id) is None:
            logger.warning(
                "checkpoint=unknown_go_model model=%s: id not in the documented table, "
                "served as OpenAI compatible /chat/completions; run "
                "`mini-extra opencode-go-models` to list the ids your key accepts.",
                model_id,
            )

        model_kwargs = {"api_base": anthropic_api_base() if needs_messages_api(model_id) else openai_api_base()}
        # The Anthropic flavor hangs off the gateway root, litellm appends `/v1/messages`.
        model_kwargs.update(self.config.model_kwargs)
        model_kwargs = _normalize_model_kwargs(model_id, model_kwargs)
        api_key = _resolve_api_key()
        if api_key:
            model_kwargs.setdefault("api_key", api_key)
        # Backends differ in which sampling params they accept.
        model_kwargs.setdefault("drop_params", True)
        self.config.model_kwargs = _with_session_headers(model_kwargs)

    def _prepare_messages_for_api(self, messages: list[dict]) -> list[dict]:
        """Like the parent's, but the gateway knows no `developer` role, and only
        the reasoning backends in `REASONING_CONTENT_MODELS` accept echoed
        `reasoning_content` assistant keys (the rest get a 400 for them)."""
        keep_reasoning = self.config.model_name.split("/", 1)[-1].lower() in REASONING_CONTENT_MODELS
        prepared = []
        for msg in super()._prepare_messages_for_api(messages):
            if isinstance(msg, dict) and msg.get("role") == "developer":
                msg = {"role": "system", **{k: v for k, v in msg.items() if k != "role"}}
            if isinstance(msg, dict) and not keep_reasoning:
                msg = {k: v for k, v in msg.items() if k != "reasoning_content"}
            prepared.append(msg)
        return prepared

    def _query(self, messages: list[dict[str, str]], **kwargs):
        headers = dict(self.config.model_kwargs.get("extra_headers") or {})
        headers.update(kwargs.get("extra_headers") or {})
        request_id = next((v for k, v in headers.items() if k.lower() == "x-request-id"), None)
        if not request_id:
            request_id = uuid.uuid4().hex
            headers["x-request-id"] = request_id
        kwargs["extra_headers"] = headers
        logger.debug("checkpoint=upstream_request model=%s request_id=%s", self.config.model_name, request_id)
        try:
            response = super()._query(messages, **kwargs)
            logger.debug("checkpoint=upstream_received model=%s request_id=%s", self.config.model_name, request_id)
            return response
        except litellm.exceptions.ServiceUnavailableError:
            logger.warning(
                "checkpoint=upstream_unavailable provider=opencode-go model=%s request_id=%s: "
                "OpenCode Go returned a service-unavailable response; mini will apply its bounded retry policy. "
                "Moving the same upstream to Rosetta does not restore its availability.",
                self.config.model_name,
                request_id,
            )
            raise
        except litellm.exceptions.BadRequestError as e:
            if not _is_missing_session_error(e):
                if _strip_rejected_sampling_param(self.config.model_kwargs, e):
                    return super()._query(messages, **kwargs)
                if _UNKNOWN_MODEL_RE.search(str(e)):
                    raise litellm.exceptions.NotFoundError(
                        f"{e} Use an id from `mini-extra opencode-go-models`.",
                        model=self.config.model_name,
                        llm_provider="opencode-go",
                    ) from e
                if _AUTH_ERROR_RE.search(str(e)):
                    raise litellm.exceptions.AuthenticationError(
                        f"{e} You can permanently set your API key with "
                        "`mini-extra config set OPENCODE_GO_API_KEY YOUR_KEY`.",
                        llm_provider="opencode-go",
                        model=self.config.model_name,
                    ) from e
                raise
            # Missing session configuration cannot be repaired by retrying.
            raise litellm.exceptions.NotFoundError(
                "OpenCode Go requires a stable 'x-opencode-session' header on every request, "
                "which mini-swe-agent sends automatically. Set OPENCODE_GO_SESSION to pin one.",
                model=self.config.model_name,
                llm_provider="opencode-go",
            ) from e


class OpencodeGoResponseModelConfig(OpencodeGoModelConfig):
    pass


class OpencodeGoResponseModel(OpencodeGoModel, LitellmResponseModel):
    """OpenCode Go ids served through the OpenAI Responses API (`/responses`)."""

    def __init__(self, **kwargs):
        kwargs.setdefault("config_class", OpencodeGoResponseModelConfig)
        super().__init__(**kwargs)
