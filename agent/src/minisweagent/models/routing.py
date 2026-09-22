"""Model-name routing predicates, import-light on purpose.

`get_model_class` / `get_model` must decide which provider module to load *before* loading
it: the litellm-backed modules cost ~198 MB and ~2 s to import, so the predicates live here and
the provider modules re-export them.
"""

import re

CLIPROXY_PREFIX = "cliproxy/"
ROSETTA_PREFIX = "rosetta/"
XIAOMI_PREFIX = "xiaomi/"
DEEPSEEK_PREFIX = "deepseek/"
OPENAI_PREFIX = "openai/"
OPENCODE_GO_PREFIX = "opencode-go/"


def is_cliproxy_model(model_name: str) -> bool:
    """Whether `model_name` should be served by cli-proxy-api."""
    return model_name.lower().startswith(CLIPROXY_PREFIX)


def is_rosetta_model(model_name: str) -> bool:
    """Whether `model_name` should be served by Rosetta."""
    return model_name.lower().startswith(ROSETTA_PREFIX)


def is_xiaomi_model(model_name: str) -> bool:
    """Whether `model_name` should be served by the Xiaomi MiMo API.

    Both `xiaomi/<id>` and a bare MiMo id (`mimo-v2.6-pro`) count; Xiaomi's own ids all
    start with `mimo`, so a bare id is unambiguous.
    """
    lowered = model_name.lower()
    return lowered.startswith(XIAOMI_PREFIX) or ("/" not in lowered and lowered.startswith("mimo"))


def is_deepseek_model(model_name: str) -> bool:
    """Whether `model_name` should be served by the DeepSeek API.

    Both `deepseek/<id>` and a bare DeepSeek id (`deepseek-flash`) count; a bare id is
    unambiguous because DeepSeek's own ids all start with `deepseek`.
    """
    lowered = model_name.lower()
    return lowered.startswith(DEEPSEEK_PREFIX) or ("/" not in lowered and lowered.startswith("deepseek"))


def is_openai_model(model_name: str) -> bool:
    """Whether `model_name` should be served by the OpenAI API."""
    return model_name.lower().startswith(OPENAI_PREFIX)


def is_opencode_go_model(model_name: str) -> bool:
    """Whether `model_name` should be served by OpenCode Go."""
    return model_name.lower().startswith(OPENCODE_GO_PREFIX)


#: OpenAI ids that reject function tools on `/chat/completions` and therefore need the
#: Responses API, e.g. `gpt-6-astra`:
#: "Function tools with reasoning_effort are not supported ... use /v1/responses".
_OPENAI_RESPONSES_ONLY_RE = re.compile(r"^gpt-6(?:$|[.-])")


def openai_needs_responses_api(model_name: str) -> bool:
    """Whether an OpenAI `model_name` can only run the agent through the Responses API."""
    bare = model_name[len(OPENAI_PREFIX) :] if is_openai_model(model_name) else model_name
    return bool(_OPENAI_RESPONSES_ONLY_RE.match(bare))
