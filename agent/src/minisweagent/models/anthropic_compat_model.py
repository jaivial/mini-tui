"""Direct Anthropic Messages API client (`POST {base}/v1/messages`) — no litellm.

Claude ids on Anthropic itself (and OpenCode Go's Anthropic-compatible endpoint) speak
the Messages API: `x-api-key` auth, content blocks with `tool_use`/`tool_result`, and
`system` as a top-level parameter. This client translates mini's OpenAI-shaped history
to that wire format and normalizes the response back to the exact message/trajectory
shape the litellm path produced (`message` with `tool_calls`, `extra.actions`,
`extra.response` as a dict, `extra.cost`, plain-text final answers as `extra.submission`),
so the journal, `--resume` and the TUI are unchanged.

Configuration (environment variables or `mini-extra config set KEY VALUE`):

    ANTHROPIC_API_KEY   default: (empty)
    ANTHROPIC_API_BASE  default: https://api.anthropic.com/v1
"""

import json
import os
from typing import Any, Literal

from minisweagent.models.errors import ProviderError
from minisweagent.models.openai_compat_model import (
    _Obj,
    _LITELLM_ONLY_KWARGS,
    _wrap,
    OpenaiCompatModel,
    OpenaiCompatModelConfig,
)
from minisweagent.models.utils.actions_toolcall import BASH_TOOL
from minisweagent.models.utils.anthropic_utils import _is_anthropic_thinking_block

DEFAULT_API_BASE = "https://api.anthropic.com/v1"
DEFAULT_API_KEY = ""
DEFAULT_API_VERSION = "2023-06-01"

#: Same tool as the chat clients, in the Messages API's flat schema form.
_fn = BASH_TOOL["function"]
ANTHROPIC_BASH_TOOL = {"name": _fn["name"], "description": _fn["description"], "input_schema": _fn["parameters"]}

_THINKING_TYPES = ("thinking", "redacted_thinking")


def _text_of(content: Any) -> str:
    """Plain text of a message content (string contents pass through)."""
    if isinstance(content, str):
        return content
    return "".join(b.get("text", "") for b in (content or []) if isinstance(b, dict) and b.get("type") == "text")


def _content_blocks(content: Any) -> list[dict]:
    """Messages API content blocks for a message content.

    List contents are replayed verbatim (thinking blocks and their signatures must
    round-trip), string contents become one text block.
    """
    if content is None:
        return []
    if isinstance(content, str):
        return [{"type": "text", "text": content}] if content else []
    blocks = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") in ("text", "thinking", "redacted_thinking", "tool_use", "tool_result", "image"):
            blocks.append(block)  # already wire-shaped (kept from a previous response)
        elif isinstance(block.get("text"), str):
            blocks.append({"type": "text", "text": block["text"], **({"cache_control": block["cache_control"]} if "cache_control" in block else {})})
    return blocks


def to_anthropic_messages(messages: list[dict]) -> tuple[list[dict], list[dict]]:
    """mini's history -> (`system` blocks, `messages` wire entries).

    Tool results become `tool_result` blocks (consecutive ones merge into a single user
    turn, as the API requires for parallel tool calls), assistant tool calls become
    `tool_use` blocks, and consecutive same-role entries merge so the wire alternates.
    `cache_control` markers (see `utils/cache_control`) ride onto the produced blocks.
    """
    system_blocks: list[dict] = []
    wire: list[dict] = []
    pending_results: list[dict] = []

    def flush() -> None:
        if pending_results:
            wire.append({"role": "user", "content": pending_results.copy()})
            pending_results.clear()

    def push(role: str, blocks: list[dict]) -> None:
        if wire and wire[-1]["role"] == role and blocks:
            wire[-1]["content"].extend(blocks)
        elif blocks:
            wire.append({"role": role, "content": blocks})

    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        marker = msg.get("cache_control")
        if role in ("system", "developer"):
            system_blocks.extend(_content_blocks(msg.get("content")))
            continue
        if role == "tool":
            result = {"type": "tool_result", "tool_use_id": msg.get("tool_call_id") or "", "content": _text_of(msg.get("content"))}
            if marker:
                result["cache_control"] = marker
            pending_results.append(result)
            continue
        flush()
        blocks = _content_blocks(msg.get("content"))
        if role == "assistant":
            for tool_call in msg.get("tool_calls") or []:
                fn = tool_call.get("function") or {}
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except ValueError:
                    args = {}
                blocks.append({"type": "tool_use", "id": tool_call.get("id") or "", "name": fn.get("name") or "", "input": args if isinstance(args, dict) else {}})
        if marker and blocks:
            blocks[-1] = {**blocks[-1], "cache_control": marker}
        push("assistant" if role == "assistant" else "user", blocks)
    flush()
    return system_blocks, wire


class AnthropicCompatModelConfig(OpenaiCompatModelConfig):
    api_base: str = os.getenv("ANTHROPIC_API_BASE", DEFAULT_API_BASE)
    api_key: str = os.getenv("ANTHROPIC_API_KEY", DEFAULT_API_KEY)
    api_version: str = DEFAULT_API_VERSION
    max_tokens: int = int(os.getenv("MSWEA_MAX_TOKENS", "8192"))
    """The Messages API requires a max output size on every request."""
    cost_tracking: Literal["default", "ignore_errors"] = os.getenv("MSWEA_COST_TRACKING", "ignore_errors")
    set_cache_control: Literal["default_end"] | None = "default_end"
    """Anthropic caching is opt-in via markers — on by default, like the litellm path."""


class AnthropicCompatModel(OpenaiCompatModel):
    """Talks to the Messages API directly (no litellm)."""

    _price_provider = "anthropic"

    def __init__(self, *, config_class=AnthropicCompatModelConfig, **kwargs):
        super().__init__(config_class=config_class, **kwargs)

    def _wire_model_name(self) -> str:
        # The wire gets the bare id (the Messages API rejects provider-qualified names).
        name = self.config.model_name
        return name[len("anthropic/") :] if name.lower().startswith("anthropic/") else name

    def _auth_headers(self) -> dict:
        return {
            "x-api-key": self.config.api_key,
            "anthropic-version": getattr(self.config, "api_version", DEFAULT_API_VERSION),
        }

    def _prepare_messages_for_api(self, messages: list[dict]) -> dict:
        system_blocks, wire = to_anthropic_messages(super()._prepare_messages_for_api(messages))
        return {"system": system_blocks, "messages": wire}

    @staticmethod
    def _tool_choice(choice: Any, parallel: Any) -> dict | None:
        """OpenAI-style tool options → the Messages API's `tool_choice` object.

        The OpenAI shape (`tool_choice: "required"`, `parallel_tool_calls: false` — what
        mini sends to keep the agent loop moving) is rejected by the Messages API as
        "invalid params"; translate it instead of relying on litellm's `drop_params`.
        """
        if choice is None and parallel is None:
            return None
        if isinstance(choice, dict):
            result = dict(choice)
        elif choice in (None, "auto"):
            result = {"type": "auto"}
        elif choice == "required":
            result = {"type": "any"}
        elif choice == "none":
            result = {"type": "none"}
        else:
            result = {"type": "tool", "name": str(choice)}
        if parallel is False:
            result["disable_parallel_tool_use"] = True
        return result

    def _query(self, wire: dict, **kwargs) -> _Obj:
        params = {k: v for k, v in (self.config.model_kwargs | kwargs).items() if k not in _LITELLM_ONLY_KWARGS}
        headers = params.pop("extra_headers", None) or {}
        tool_choice = self._tool_choice(params.pop("tool_choice", None), params.pop("parallel_tool_calls", None))
        body = {
            "model": self._wire_model_name(),
            "messages": wire["messages"],
            "tools": [ANTHROPIC_BASH_TOOL],
            "max_tokens": params.pop("max_tokens", self.config.max_tokens),
            **params,
        }
        if tool_choice:
            body["tool_choice"] = tool_choice
        if wire["system"]:
            body["system"] = wire["system"]
        try:
            data = self._post("/messages", body, headers=headers)
        except ProviderError as e:
            # Some Messages flavors only speak `tool_choice: auto` (Qwen rejects `any` and
            # `tool` outright). Retry the same request unforced before giving up — a real
            # bad request fails identically without the parameter.
            if e.status != 400 or not tool_choice:
                raise
            body.pop("tool_choice", None)
            data = self._post("/messages", body, headers=headers)
        if "content" not in data:
            raise Exception(f"response without content from {self.config.api_base}: {str(data)[:300]}")
        return _wrap(self._normalize(data))

    def _normalize(self, data: dict) -> dict:
        """Messages API response -> the chat-completions shape the shared `query()` expects.
        The raw response stays in the dict (it becomes `extra.response`)."""
        blocks = data.get("content") or []
        has_thinking = any(_is_anthropic_thinking_block(b) for b in blocks)
        text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
        content = [b for b in blocks if b.get("type") in _THINKING_TYPES + ("text",)] if has_thinking else (text or None)
        tool_calls = [
            {"id": b.get("id"), "type": "function", "function": {"name": b.get("name"), "arguments": json.dumps(b.get("input") or {})}}
            for b in blocks
            if b.get("type") == "tool_use"
        ]
        message = {"role": "assistant", "content": content, **({"tool_calls": tool_calls} if tool_calls else {})}
        finish = {"tool_use": "tool_use", "max_tokens": "length", "end_turn": "stop", "stop_sequence": "stop"}.get(
            data.get("stop_reason") or "", data.get("stop_reason")
        )
        return {**data, "choices": [{"finish_reason": finish, "message": message}]}

    @staticmethod
    def _final_answer(message) -> str | None:
        """Text without tool calls is the final answer — even when thinking blocks
        made the content a list."""
        if message.tool_calls:
            return None
        text = (message.content if isinstance(message.content, str) else _text_of(message.content) or "").strip()
        return text or None
