"""Direct OpenAI Responses API client (`POST {base}/responses`) — no litellm.

Ids that reject function tools on `/chat/completions` (e.g. `gpt-6-astra`) are served on
the Responses API. This mirrors `LitellmResponseModel`'s exact trajectory shape: each
response is stored raw (`object: "response"` with its `output` items) and flattened back
into output items for stateless replays; observations are `function_call_output` items.
"""

import logging
import time

from minisweagent.exceptions import FormatError
from minisweagent.models import GLOBAL_MODEL_STATS
from minisweagent.models.openai_compat_model import _wrap, OpenaiCompatModel, _LITELLM_ONLY_KWARGS
from minisweagent.models.utils.actions_toolcall_response import (
    BASH_TOOL_RESPONSE_API,
    finish_reason_from_responses_api,
    format_toolcall_observation_messages,
    parse_toolcall_actions_response,
)
from minisweagent.models.utils.retry import retry

logger = logging.getLogger("responses_compat_model")


class ResponsesCompatModel(OpenaiCompatModel):
    """Talks to the Responses API directly (no litellm).

    The config is `OpenaiCompatModelConfig` (same fields as `LitellmResponseModel`
    consumed: `model_name`, `model_kwargs`, `cost_tracking`, templates).
    """

    def _prepare_messages_for_api(self, messages: list[dict]) -> list[dict]:
        """Flatten stored responses into their output items for stateless API calls."""
        result = []
        for msg in messages:
            if msg.get("object") == "response":
                for item in msg.get("output", []):
                    result.append({k: v for k, v in item.items() if k != "extra"})
            else:
                result.append({k: v for k, v in msg.items() if k != "extra"})
        return result

    def _query(self, messages: list[dict], **kwargs):
        params = {k: v for k, v in (self.config.model_kwargs | kwargs).items() if k not in _LITELLM_ONLY_KWARGS}
        headers = params.pop("extra_headers", None) or {}
        body = {"model": self._wire_model_name(), "input": messages, "tools": [BASH_TOOL_RESPONSE_API], **params}
        data = self._post("/responses", body, headers=headers)
        return _wrap(data)

    def query(self, messages: list[dict], **kwargs) -> dict:
        for attempt in retry(logger=logger, abort_exceptions=self.abort_exceptions):
            with attempt:
                response = self._query(self._prepare_messages_for_api(messages), **kwargs)
        cost_output = self._calculate_cost(response)
        GLOBAL_MODEL_STATS.add(cost_output["cost"])
        try:
            actions = self._parse_actions(response)
        except FormatError as e:
            e.messages[0]["extra"].update(cost_output)
            try:
                e.messages[0]["extra"]["response"] = response.model_dump()
            except Exception:
                e.messages[0]["extra"]["response"] = repr(response)
            raise
        message = response.model_dump()
        message["extra"] = {
            "actions": actions,
            **cost_output,
            "timestamp": time.time(),
        }
        return message

    def _parse_actions(self, response) -> list[dict]:
        return parse_toolcall_actions_response(
            response.get("output") or [],
            format_error_template=self.config.format_error_template,
            template_kwargs={"finish_reason": finish_reason_from_responses_api(response)},
        )

    def format_observation_messages(self, message: dict, outputs: list[dict], template_vars: dict | None = None) -> list[dict]:
        """Format execution outputs into function_call_output messages."""
        return format_toolcall_observation_messages(
            actions=message.get("extra", {}).get("actions", []),
            outputs=outputs,
            observation_template=self.config.observation_template,
            template_vars=template_vars,
            multimodal_regex=self.config.multimodal_regex,
        )
