"""Cache control utilities are mostly for Anthropic models.
They are used to explicitly set cache control points.
"""

import copy
import warnings
from typing import Literal


def _get_content_text(entry: dict) -> str | None:
    if entry["content"] is None:
        return None
    if isinstance(entry["content"], str):
        return entry["content"]
    assert len(entry["content"]) == 1, "Expected single message in content"
    return entry["content"][0]["text"]


def _plain_text(entry: dict) -> str:
    content = entry.get("content")
    if isinstance(content, str):
        return content
    return "".join(b.get("text", "") for b in content or [] if isinstance(b, dict))


def _clear_all(entry: dict) -> None:
    for block in entry["content"] if isinstance(entry.get("content"), list) else []:
        if isinstance(block, dict):
            block.pop("cache_control", None)
    entry.pop("cache_control", None)


def _mark(entry: dict, marker: dict) -> None:
    """Put `marker` on the last block of `entry` (multi-block contents allowed)."""
    content = entry.get("content")
    if entry.get("role") == "tool" or not content:
        entry["cache_control"] = marker
    elif isinstance(content, str):
        entry["content"] = [{"type": "text", "text": content, "cache_control": marker}]
    elif isinstance(content[-1], dict):
        content[-1]["cache_control"] = marker
    else:
        entry["cache_control"] = marker


def _clear_cache_control(entry: dict) -> None:
    if isinstance(entry["content"], list):
        assert len(entry["content"]) == 1, "Expected single message in content"
        entry["content"][0].pop("cache_control", None)
    # Note: entry["content"] can be None for assistant messages with only tool_use
    entry.pop("cache_control", None)


def _set_cache_control(entry: dict, marker: dict | None = None) -> None:
    marker = marker or {"type": "ephemeral"}
    # Handle None content (e.g., assistant messages with only tool_use)
    if entry["content"] is None:
        entry["cache_control"] = marker
        return

    if not isinstance(entry["content"], list):
        entry["content"] = [  # type: ignore
            {
                "type": "text",
                "text": _get_content_text(entry),
                "cache_control": marker,
            }
        ]
    else:
        entry["content"][-1]["cache_control"] = marker
    if entry["role"] == "tool":
        # Workaround for weird bug
        entry["content"][-1].pop("cache_control", None)
        entry["cache_control"] = marker


CacheMode = Literal["default_end", "rolling"]

#: Anthropic accepts at most four cache breakpoints per request.
MAX_BREAKPOINTS = 4


def rolling_breakpoints(messages: list[dict]) -> list[int]:
    """Indices to mark in `rolling` mode, at most `MAX_BREAKPOINTS`.

    * end of the head (system + first task message): stable for the whole run, so it survives
      context compactions and is shared by the compaction summarizer call;
    * the latest compaction summary: the start of the new append-only segment;
    * the end of the previous step (the last message before the newest assistant turn): the
      exact prefix the previous request wrote, so the read never depends on the provider's
      20-block lookback (a turn with many parallel tool results would exceed it);
    * the last message: written now, read by the next step.
    """
    if not messages:
        return []
    head = 0
    while head < len(messages) and messages[head].get("role") == "system":
        head += 1
    if head < len(messages) and messages[head].get("role") == "user":
        head += 1
    last = len(messages) - 1
    compaction = next(
        (i for i in range(last, head - 1, -1) if _plain_text(messages[i]).startswith("[Context compacted")),
        None,
    )
    assistant = next((i for i in range(last, -1, -1) if messages[i].get("role") == "assistant"), None)
    previous = assistant - 1 if assistant is not None and assistant > 0 else None
    wanted = [head - 1, compaction, previous, last]
    marks = sorted({i for i in wanted if i is not None and 0 <= i <= last})
    while len(marks) > MAX_BREAKPOINTS:
        marks.pop(1)
    return marks


def set_cache_control(
    messages: list[dict],
    *,
    mode: CacheMode | None = "default_end",
    last_n_messages_offset: int = 0,
    ttl: str | None = None,
) -> list[dict]:
    """This messages processor adds manual cache control marks to the messages.

    `default_end` marks the last message; `rolling` marks the stable points listed in
    `rolling_breakpoints`. `ttl` (e.g. "1h") is forwarded in the markers.
    """
    if mode is None:
        return messages
    if mode not in ("default_end", "rolling"):
        raise ValueError(f"Invalid mode: {mode}")
    if last_n_messages_offset:
        warnings.warn("last_n_messages_offset is deprecated and will be removed in the future. It has no effect.")

    marker = {"type": "ephemeral", **({"ttl": ttl} if ttl else {})}
    if mode == "rolling":
        messages = copy.deepcopy(messages)
        for entry in messages:
            _clear_all(entry)
        for i in rolling_breakpoints(messages):
            _mark(messages[i], marker)
        return messages
    messages = copy.deepcopy(messages)
    new_messages = []
    for i_entry, entry in enumerate(reversed(messages)):
        _clear_cache_control(entry)
        if i_entry == 0:
            _set_cache_control(entry, marker)
        new_messages.append(entry)
    return list(reversed(new_messages))
