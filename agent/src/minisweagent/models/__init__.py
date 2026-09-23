"""This file provides convenience functions for selecting models.
You can ignore this file completely if you explicitly set your model in your run script.
"""

import copy
import importlib
import os
import threading

from minisweagent import Model


class GlobalModelStats:
    """Global model statistics tracker with optional limits."""

    def __init__(self):
        self._cost = 0.0
        self._n_calls = 0
        self._lock = threading.Lock()
        self.cost_limit = float(os.getenv("MSWEA_GLOBAL_COST_LIMIT", "0"))
        self.call_limit = int(os.getenv("MSWEA_GLOBAL_CALL_LIMIT", "0"))
        if (self.cost_limit > 0 or self.call_limit > 0) and not os.getenv("MSWEA_SILENT_STARTUP"):
            print(f"Global cost/call limit: ${self.cost_limit:.4f} / {self.call_limit}")

    def add(self, cost: float) -> None:
        """Add a model call with its cost, checking limits."""
        with self._lock:
            self._cost += cost
            self._n_calls += 1
        if 0 < self.cost_limit < self._cost or 0 < self.call_limit < self._n_calls + 1:
            raise RuntimeError(f"Global cost/call limit exceeded: ${self._cost:.4f} / {self._n_calls}")

    @property
    def cost(self) -> float:
        return self._cost

    @property
    def n_calls(self) -> int:
        return self._n_calls


GLOBAL_MODEL_STATS = GlobalModelStats()


def get_model(input_model_name: str | None = None, config: dict | None = None) -> Model:
    """Get an initialized model object from any kind of user input or settings."""
    resolved_model_name = get_model_name(input_model_name, config)
    if config is None:
        config = {}
    config = copy.deepcopy(config)
    config["model_name"] = resolved_model_name

    model_class = get_model_class(resolved_model_name, config.pop("model_class", ""))

    from minisweagent.models.routing import (
        is_cliproxy_model,
        is_deepseek_model,
        is_openai_model,
        is_opencode_go_model,
        is_rosetta_model,
        is_xiaomi_model,
    )

    if (
        any(s in resolved_model_name.lower() for s in ["anthropic", "sonnet", "opus", "claude"])
        and "set_cache_control" not in config
        # Rosetta / cli-proxy ids often contain "claude" but are served over the OpenAI protocol,
        # which does not understand Anthropic cache_control markers.
        and not is_rosetta_model(resolved_model_name)
        and not is_cliproxy_model(resolved_model_name)
        and not is_deepseek_model(resolved_model_name)
        and not is_openai_model(resolved_model_name)
        and not is_opencode_go_model(resolved_model_name)
        and not is_xiaomi_model(resolved_model_name)
    ):
        # Select cache control for Anthropic models by default
        config["set_cache_control"] = "default_end"

    return model_class(**config)


def get_model_name(input_model_name: str | None = None, config: dict | None = None) -> str:
    """Get a model name from any kind of user input or settings."""
    if config is None:
        config = {}
    if input_model_name:
        return input_model_name
    if from_config := config.get("model_name"):
        return from_config
    if from_env := os.getenv("MSWEA_MODEL_NAME"):
        return from_env
    raise ValueError("No default model set. Please run `mini-extra config setup` to set one.")


_MODEL_CLASS_MAPPING = {
    "litellm": "minisweagent.models.litellm_model.LitellmModel",
    "litellm_textbased": "minisweagent.models.litellm_textbased_model.LitellmTextbasedModel",
    "litellm_response": "minisweagent.models.litellm_response_model.LitellmResponseModel",
    "openrouter": "minisweagent.models.openrouter_model.OpenRouterModel",
    "openrouter_textbased": "minisweagent.models.openrouter_textbased_model.OpenRouterTextbasedModel",
    "openrouter_response": "minisweagent.models.openrouter_response_model.OpenRouterResponseModel",
    "portkey": "minisweagent.models.portkey_model.PortkeyModel",
    "portkey_response": "minisweagent.models.portkey_response_model.PortkeyResponseAPIModel",
    "requesty": "minisweagent.models.requesty_model.RequestyModel",
    "rosetta": "minisweagent.models.rosetta_model.RosettaModel",
    "cliproxy": "minisweagent.models.cliproxy_model.CliproxyModel",
    "deepseek": "minisweagent.models.deepseek_model.DeepseekModel",
    "opencode_go": "minisweagent.models.opencode_go_model.OpencodeGoModel",
    "opencode_go_response": "minisweagent.models.opencode_go_model.OpencodeGoResponseModel",
    "openai": "minisweagent.models.openai_model.OpenaiModel",
    "openai_response": "minisweagent.models.openai_model.OpenaiResponseModel",
    "xiaomi": "minisweagent.models.xiaomi_model.XiaomiModel",
    "openai_compat": "minisweagent.models.openai_compat_model.OpenaiCompatModel",
    "anthropic_compat": "minisweagent.models.anthropic_compat_model.AnthropicCompatModel",
    "responses_compat": "minisweagent.models.responses_compat_model.ResponsesCompatModel",
    "deterministic": "minisweagent.models.test_models.DeterministicModel",
}


def get_model_class(model_name: str, model_class: str = "") -> type:
    """Select the best model class.

    If a model_class is provided (as shortcut name, or as full import path,
    e.g., "anthropic" or "minisweagent.models.anthropic.AnthropicModel"),
    it takes precedence over the `model_name`.
    Otherwise, the model_name is used to select the best model class.
    """
    if not model_class:
        # Routing predicates are import-light: picking a gateway class must not load litellm.
        from minisweagent.models.routing import (
            is_cliproxy_model,
            is_deepseek_model,
            is_openai_model,
            is_opencode_go_model,
            is_rosetta_model,
            is_xiaomi_model,
        )
        from minisweagent.models.routing import openai_needs_responses_api as needs_responses_api

        from minisweagent.models.routing import is_anthropic_model

        if is_opencode_go_model(model_name):
            # Go serves ids on three endpoints; the Anthropic compatible one is picked inside
            # OpencodeGoModel, the Responses API one needs a different class.
            from minisweagent.models.opencode_go_model import needs_responses_api as needs_go_responses_api

            model_class = "opencode_go_response" if needs_go_responses_api(model_name) else "opencode_go"
        elif is_rosetta_model(model_name):
            model_class = "rosetta"
        elif is_cliproxy_model(model_name):
            model_class = "cliproxy"
        elif is_deepseek_model(model_name):
            model_class = "deepseek"
        elif is_xiaomi_model(model_name):
            model_class = "xiaomi"
        elif is_openai_model(model_name):
            # Some ids (e.g. gpt-6-astra) reject function tools on /chat/completions.
            model_class = "openai_response" if needs_responses_api(model_name) else "openai"
        elif is_anthropic_model(model_name):
            model_class = "anthropic_compat"
        else:
            # Registry rows (moonshot/, zhipu/, groq/, zai/, minimax/, openrouter/) pick
            # their protocol; anything else is a generic OpenAI-compatible endpoint
            # reached through `OPENAI_API_BASE` (the litellm zoo is now opt-in via
            # `--model-class litellm` and the `[litellm]` extra).
            from minisweagent.models import providers

            protocol = providers.protocol_for(model_name)
            model_class = {"messages": "anthropic_compat", "responses": "responses_compat"}.get(protocol, "openai_compat")

    if model_class:
        full_path = _MODEL_CLASS_MAPPING.get(model_class, model_class)
        try:
            module_name, class_name = full_path.rsplit(".", 1)
            module = importlib.import_module(module_name)
            return getattr(module, class_name)
        except ImportError as e:
            if "litellm" in full_path:
                msg = (
                    f"Model class {full_path} needs litellm, which is an optional extra: "
                    f"`pip install 'mini-swe-agent[litellm]'`. Original error: {e}"
                )
                raise ValueError(msg) from e
            msg = f"Unknown model class: {model_class} (resolved to {full_path}, available: {_MODEL_CLASS_MAPPING})"
            raise ValueError(msg) from e
        except (ValueError, AttributeError):
            msg = f"Unknown model class: {model_class} (resolved to {full_path}, available: {_MODEL_CLASS_MAPPING})"
            raise ValueError(msg)

    # Default to the generic OpenAI-compatible client (any endpoint via OPENAI_API_BASE).
    from minisweagent.models.openai_compat_model import OpenaiCompatModel

    return OpenaiCompatModel
