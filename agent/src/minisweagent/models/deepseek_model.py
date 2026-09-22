"""DeepSeek API support for mini-swe-agent.

DeepSeek hosts its models behind an OpenAI-compatible `/chat/completions`
surface at `https://api.deepseek.com`, which litellm supports through the
native `deepseek/` provider.

Usage:

    mini -m deepseek/deepseek-chat
    mini -m deepseek/deepseek-v3.2
    mini -m deepseek-flash              # bare DeepSeek ids work too
    mini -m deepseek/deepseek-v4.1-flash
    mini -m deepseek-v41-flash          # spelling without the dot works too

The `deepseek/` prefix is *not* stripped: it is exactly how litellm identifies
the DeepSeek provider, which gives us working cost tracking for every id that
litellm knows the prices of (ids it does not know are reported as cost 0.0).

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

import litellm

from minisweagent.models.litellm_model import LitellmModel, LitellmModelConfig
from minisweagent.models.routing import DEEPSEEK_PREFIX, is_deepseek_model  # noqa: F401 (re-exported)


DEFAULT_API_BASE = "https://api.deepseek.com/v1"
DEFAULT_API_KEY = ""
"""litellm picks up `DEEPSEEK_API_KEY` when no explicit key is set."""



def strip_deepseek_prefix(model_name: str) -> str:
    """Remove the `deepseek/` routing prefix from a model name."""
    if is_deepseek_model(model_name):
        return model_name[len(DEEPSEEK_PREFIX) :]
    return model_name


#: Ids DeepSeek serves under a different canonical id, and the spellings accepted for
#: them. DeepSeek re-points several ids at the same backend (`deepseek-chat`,
#: `deepseek-v4-flash` and `deepseek-flash` all answer as `deepseek-flash`), while ids it
#: does not know are rejected with a 400 before a single token is generated. Routing an
#: advertised id to the canonical id DeepSeek serves keeps such runs alive and, whenever
#: the canonical id is one litellm has prices for, keeps cost tracking exact.
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
# id characters instead of "up to the next period". The message is quoted inside litellm's
# BadRequestError text, hence the explicit character class.
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


class DeepseekModelConfig(LitellmModelConfig):
    resolve_aliases: bool = True
    """Rewrite advertised DeepSeek ids (e.g. `deepseek-v4.1-flash`) to the id DeepSeek
    serves for them (`deepseek-v4-flash`). Turn this off for a DeepSeek-compatible
    endpoint that defines its own id space, where an id is exactly what you pass."""

    model_kwargs: dict[str, Any] = {}
    cost_tracking: Literal["default", "ignore_errors"] = os.getenv("MSWEA_COST_TRACKING", "ignore_errors")
    """DeepSeek ships new model ids faster than litellm maps their prices, and an unmapped id
    would otherwise abort a run as soon as the first response comes back. Set `cost_tracking:
    default` (or `export MSWEA_COST_TRACKING=default` before starting `mini`) if you want
    unmapped ids to be fatal."""


class DeepseekModel(LitellmModel):
    """Talks to the DeepSeek API through litellm's native `deepseek` provider."""

    def __init__(self, **kwargs):
        kwargs.setdefault("config_class", DeepseekModelConfig)
        super().__init__(**kwargs)

        # A bare id (e.g. `deepseek-chat`) is unambiguous, so pin the provider prefix
        # to it; provider-qualified names are passed through untouched.
        if "/" not in self.config.model_name:
            self.config.model_name = f"{DEEPSEEK_PREFIX}{self.config.model_name}"

        # Keep the id the user asked for for messages, but send (and price) the id
        # DeepSeek actually serves, so aliases do not die on the first request.
        self.requested_model_name = self.config.model_name
        if self.config.resolve_aliases:
            self.config.model_name = resolve_deepseek_alias(self.config.model_name)

        model_kwargs = dict(self.config.model_kwargs)
        model_kwargs.setdefault("api_base", os.getenv("DEEPSEEK_API_BASE", DEFAULT_API_BASE).rstrip("/"))
        api_key = os.getenv("DEEPSEEK_API_KEY", DEFAULT_API_KEY)
        if api_key:
            # Otherwise leave it to litellm to resolve DEEPSEEK_API_KEY and complain loudly.
            model_kwargs.setdefault("api_key", api_key)
        self.config.model_kwargs = model_kwargs

    def _query(self, messages: list[dict[str, str]], **kwargs):
        try:
            return super()._query(messages, **kwargs)
        except litellm.exceptions.BadRequestError as e:
            # DeepSeek reports both of these as 400s (litellm: BadRequestError), which the retry
            # loop would hammer. Re-raise them as the errors they are, so the run aborts at once.
            if unsupported := _unsupported_model(e):
                names, passed = unsupported
                suggested = DEEPSEEK_MODEL_ALIASES.get(passed.lower())
                hint = (
                    f" Request `{DEEPSEEK_PREFIX}{suggested}` instead: DeepSeek serves it as that id."
                    if suggested
                    else " Run `mini-extra deepseek-models` to list them."
                )
                raise litellm.exceptions.NotFoundError(
                    f"DeepSeek has no model id '{passed}'. Ids your key accepts: {names}.{hint}",
                    model=self.config.model_name,
                    llm_provider="deepseek",
                ) from e
            if "LLM Provider NOT provided" in str(e):
                # litellm could not infer a provider; nothing we can retry on.
                raise litellm.exceptions.NotFoundError(
                    f"{e.message} Use a DeepSeek id such as `deepseek/deepseek-flash`.",
                    model=self.config.model_name,
                    llm_provider="deepseek",
                ) from e
            if not _is_auth_error(e):
                raise
            raise litellm.exceptions.AuthenticationError(
                f"{e.message} You can permanently set your API key with "
                "`mini-extra config set DEEPSEEK_API_KEY YOUR_KEY`.",
                llm_provider="deepseek",
                model=self.config.model_name,
            ) from e
