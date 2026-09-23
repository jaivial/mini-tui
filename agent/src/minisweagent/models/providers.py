"""Provider registry: one row per provider — prefix, direct base URL, key env, protocol.

Import-light on purpose (like `routing.py`): `get_model_class` consults it before any
client module loads. Providers with quirks (DeepSeek aliases, Xiaomi, the local gateways,
OpenCode Go) keep their own model classes; this registry covers the plain endpoints and
gives every provider its own env slot (`ZAI_API_BASE`, `MINIMAX_API_BASE`, …) instead of
funnelling them all through a single `OPENAI_API_BASE`. See docs/PLAN-litellm-detach.md.
"""

import os
from dataclasses import dataclass, field
from typing import Literal

Protocol = Literal["chat", "messages", "responses"]


@dataclass(frozen=True)
class Provider:
    id: str
    prefix: str
    base_env: str
    default_base: str
    key_env: str
    default_key: str = ""
    protocol: Protocol = "chat"
    strip_prefix: bool = True

    def applies_to(self, model_name: str) -> bool:
        return model_name.lower().startswith(self.prefix.lower())

    def strip(self, model_name: str) -> str:
        return model_name[len(self.prefix) :] if self.applies_to(model_name) else model_name

    def settings(self) -> tuple[str, str]:
        """(base URL, API key) — explicit env over the documented default."""
        return os.getenv(self.base_env, self.default_base).rstrip("/"), os.getenv(self.key_env, self.default_key)


#: Plain OpenAI-compatible / Anthropic-compatible endpoints. Order matters only for
#: debugging; lookups match on the model name prefix.
PROVIDERS: list[Provider] = [
    Provider("anthropic", "anthropic/", "ANTHROPIC_API_BASE", "https://api.anthropic.com/v1", "ANTHROPIC_API_KEY", protocol="messages"),
    Provider("moonshot", "moonshot/", "MOONSHOT_API_BASE", "https://api.moonshot.ai/v1", "MOONSHOT_API_KEY"),
    Provider("zhipu", "zhipu/", "ZHIPU_API_BASE", "https://open.bigmodel.cn/api/paas/v4", "ZHIPUAI_API_KEY"),
    Provider("groq", "groq/", "GROQ_API_BASE", "https://api.groq.com/openai/v1", "GROQ_API_KEY"),
    Provider("zai", "zai/", "ZAI_API_BASE", "https://api.z.ai/api/coding/paas/v4", "ZAI_API_KEY"),
    Provider("minimax", "minimax/", "MINIMAX_API_BASE", "https://api.minimax.io/v1", "MINIMAX_API_KEY"),
    Provider("openrouter", "openrouter/", "OPENROUTER_API_BASE", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
]

_BY_PREFIX = {p.prefix.lower(): p for p in PROVIDERS}


def lookup(model_name: str) -> Provider | None:
    """Registry row for a model name (prefix match), else None."""
    lowered = model_name.lower()
    for prefix, provider in _BY_PREFIX.items():
        if lowered.startswith(prefix):
            return provider
    return None


def protocol_for(model_name: str) -> Protocol | None:
    """Wire protocol for a model name, else None (unknown to the registry)."""
    provider = lookup(model_name)
    return provider.protocol if provider else None
