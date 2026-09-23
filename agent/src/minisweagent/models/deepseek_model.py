"""DeepSeek API support for mini-swe-agent \u2014 direct, no litellm.

DeepSeek hosts its models behind an OpenAI-compatible `/chat/completions` surface at
`https://api.deepseek.com`, which `OpenaiCompatModel` calls directly (base URL per
provider: `DEEPSEEK_API_BASE`). Cost tracking comes from `models/prices.py` (ids
without a price row report cost 0.0).

Usage:

    mini -m deepseek/deepseek-chat
    mini -m deepseek/deepseek-v3.2
    mini -m deepseek-flash              # bare DeepSeek ids work too
    mini -m deepseek/deepseek-v4.1-flash
    mini -m deepseek-v41-flash          # spelling without the dot works too

Configuration (environment variables or `mini-extra config set KEY VALUE`):

    DEEPSEEK_API_KEY    default: (empty)
    DEEPSEEK_API_BASE   default: https://api.deepseek.com/v1

Note: `deepseek/deepseek-reasoner` does not accept tool calls, so it cannot
drive the agent loop. Use a tool-calling model such as `deepseek/deepseek-chat`
or `deepseek/deepseek-v3.2`.
"""

import os
import re
from typing import Any, Literal

from minisweagent.models.errors import ProviderAbortError, ProviderError
from minisweagent.models.openai_compat_model import OpenaiCompatModel, OpenaiCompatModelConfig, gateway_settings
from minisweagent.models.routing import DEEPSEEK_PREFIX, is_deepseek_model  # noqa: F401 (re-exported)


DEFAULT_API_BASE = "https://api.deepseek.com/v1"
DEFAULT_API_KEY = ""


def strip_deepseek_prefix(model_name: str) -> str:
    """Remove the `deepseek/` routing prefix from a model name."""
    if is_deepseek_model(model_name):
        return model_name[len(DEEPSEEK_PREFIX) :]
    return model_name


#: Ids DeepSeek serves under a different canonical id, and the spellings accepted for
#: them. DeepSeek re-points several ids at the same backend (`deepseek-chat`,
#: `deepseek-v4-flash` and `deepseek-flash` all answer as `deepseek-flash`), while ids it
#: does not know are rejected with a 400 before a single token is generated. Routing an
#: advertised id to the canonical id DeepSeek serves keeps such runs alive and keeps
# cost tracking exact whenever the canonical id has a price row.
DEEPSEEK_MODEL_ALIASES: dict[str, str] = {
    # `v4.1-flash` is the name DeepSeek markets and the OpenCode Go catalog lists; the
    # DeepSeek API itself still only accepts the `v4` spelling for the flash tier.
    "deepseek-v4.1-flash": "deepseek-v4-flash",
    "deepseek-v41-flash": "deepseek-v4-flash",
}


def resolve_deepseek_alias(model_name: str) -> str:
    """Map `model_name` to the id the DeepSeek API actually serves.

    Unknown ids (including every provider-qualified non-DeepSeek name) come back
    unchanged, so this is always safe to call.
    """
    if model_name.lower().startswith(DEEPSEEK_PREFIX):
        # Slice the original name, so a mixed-case prefix keeps its spelling.
        bare = model_name[len(DEEPSEEK_PREFIX) :]
        prefix = model_name[: len(DEEPSEEK_PREFIX)]
        return f"{prefix}{DEEPSEEK_MODEL_ALIASES.get(bare.lower(), bare)}"
    return DEEPSEEK_MODEL_ALIASES.get(model_name.lower(), model_name)


def _is_auth_error(exception: Exception) -> bool:
    text = str(exception).lower()
    return "authentication_error" in text or "authentication fails" in text


# Model ids contain dots (e.g. `deepseek-v4.1-flash`), so `passed` is matched as a run of
# id characters instead of "up to the next period". The message is quoted inside the
# provider's 400 error body, hence the explicit character class.
_UNSUPPORTED_MODEL_RE = re.compile(
    r"supported API model names are (?P<names>.+?), but you passed (?P<passed>[\w./-]+)",
    re.IGNORECASE,
)


def _unsupported_model(exception: Exception) -> tuple[str, str] | None:
    """(accepted ids, id that was passed), if DeepSeek rejected an unknown model id."""
    if match := _UNSUPPORTED_MODEL_RE.search(str(exception)):
        # The id is followed by a period in the raw message; ids themselves never end in one.
        return match.group("names"), match.group("passed").rstrip(".")
    return None


class DeepseekModelConfig(OpenaiCompatModelConfig):
    resolve_aliases: bool = True
    """Rewrite advertised DeepSeek ids (e.g. `deepseek-v4.1-flash`) to the id DeepSeek
    serves for them (`deepseek-v4-flash`). Turn this off for a DeepSeek-compatible
    endpoint that defines its own id space, where an id is exactly what you pass."""

    model_kwargs: dict[str, Any] = {}
    cost_tracking: Literal["default", "ignore_errors"] = os.getenv("MSWEA_COST_TRACKING", "ignore_errors")
    """DeepSeek ships new model ids faster than price tables track, and an unpriced id
    would otherwise abort a run as soon as the first response comes back. Set
    `cost_tracking: default` (or `export MSWEA_COST_TRACKING=default` before starting
    `mini`) if you want unpriced ids to be fatal."""


class DeepseekModel(OpenaiCompatModel):
    """Talks to the DeepSeek API directly (OpenAI-compatible, no litellm)."""

    _price_provider = "deepseek"

    def __init__(self, **kwargs):
        kwargs.setdefault("config_class", DeepseekModelConfig)
        model_kwargs = dict(kwargs.get("model_kwargs") or {})
        kwargs.update(gateway_settings(model_kwargs, "DEEPSEEK_API_BASE", DEFAULT_API_BASE, "DEEPSEEK_API_KEY", DEFAULT_API_KEY))
        kwargs["model_kwargs"] = {k: v for k, v in model_kwargs.items() if k not in ("api_base", "api_key")}
        super().__init__(**kwargs)

        # A bare id (e.g. `deepseek-chat`) is unambiguous, so pin the provider prefix
        # to it; provider-qualified names pass through.
        if "/" not in self.config.model_name:
            self.config.model_name = f"{DEEPSEEK_PREFIX}{self.config.model_name}"

        # Keep the id the user asked for for messages, but send (and price) the id
        # DeepSeek actually serves, so aliases do not die on the first request.
        self.requested_model_name = self.config.model_name
        if self.config.resolve_aliases:
            self.config.model_name = resolve_deepseek_alias(self.config.model_name)

    def _wire_model_name(self) -> str:
        # The wire gets the bare id (the API rejects provider-qualified names).
        return strip_deepseek_prefix(self.config.model_name)

    def _query(self, messages: list[dict[str, str]], **kwargs):
        try:
            return super()._query(messages, **kwargs)
        except ProviderError as e:
            # DeepSeek reports both of these as 400s, which the retry loop would hammer.
            # Re-raise them as the errors they are, so the run aborts at once.
            if unsupported := _unsupported_model(e):
                names, passed = unsupported
                suggested = DEEPSEEK_MODEL_ALIASES.get(passed.lower())
                hint = (
                    f" Request `deepseek/{suggested}` instead: DeepSeek serves it as that id."
                    if suggested
                    else " Run `mini-extra deepseek-models` to list them."
                )
                raise ProviderAbortError(
                    f"DeepSeek has no model id '{passed}'. Ids your key accepts: {names}.{hint}", e.status
                ) from e
            if not _is_auth_error(e):
                raise
            raise ProviderAbortError(
                f"{e.message} You can permanently set your API key with "
                "`mini-extra config set DEEPSEEK_API_KEY YOUR_KEY`.",
                e.status,
            ) from e
