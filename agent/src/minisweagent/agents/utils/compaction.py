"""Context-window bookkeeping for automatic compaction.

The trajectory stays append-only (journal, TUI and `--resume` depend on it). Compaction appends
one `user` message carrying `extra.compaction`; the model is sent a *view* of the log:

    head (system + first task message) + compaction summary + tail copies + everything after

The head is byte-identical across compactions, so its prompt-cache entry survives them, and after
a compaction the view grows append-only again, so the cache hits on every following step.
"""

import json
import re
from pathlib import Path

from minisweagent import global_config_dir

LEARNED_WINDOWS_FILE = Path(global_config_dir) / "context_windows.json"

#: (pattern on the lowercased model id, context window in tokens); first match wins.
KNOWN_WINDOWS: tuple[tuple[str, int], ...] = (
    (r"claude-(opus|sonnet|fable)-(4-[6-9]|5)", 1_000_000),
    (r"claude|anthropic", 200_000),
    (r"gpt-5|codex", 400_000),
    (r"gpt-4\.1", 1_000_000),
    (r"mimo", 1_000_000),
    (r"gemini", 1_000_000),
    (r"deepseek", 128_000),
)
DEFAULT_WINDOW = 200_000
#: Fallback characters per token before any response has reported real usage.
DEFAULT_CHARS_PER_TOKEN = 3.5

_OVERFLOW_PATTERNS = re.compile(
    r"prompt is too long|context.?length|context.?window|maximum context|too many (input )?tokens"
    r"|input is too long|exceeds? the (model'?s? )?(maximum|context)|reduce the length|request too large",
    re.IGNORECASE,
)
_LIMIT_PATTERNS = (
    re.compile(r"(\d[\d,]*) tokens? > (\d[\d,]*)"),
    re.compile(r"maximum context length is (\d[\d,]*)", re.IGNORECASE),
    re.compile(r"context (?:window|length) (?:of|is) (\d[\d,]*)", re.IGNORECASE),
)

SUMMARY_PROMPT = """\
CONTEXT COMPACTION REQUEST — do not call any tool; reply with plain text only.

The conversation is about to exceed the context window. Write a summary that fully replaces \
the earlier messages: after this, you will only see the system prompt, the first task message, \
your summary, and the most recent messages verbatim. Anything you omit is lost for good.

Use exactly these sections:
1. Goal and user intent — every request the user made, including follow-ups and corrections, \
and their constraints and preferences (quote them where the wording matters).
2. Key facts discovered — environment, repositories, branches, worktrees, paths, services, \
URLs, IDs, PR numbers, versions, commands that work, and how things are wired together.
3. Files and code — each file read or changed, what changed and why; include short snippets \
when exact code matters.
4. Errors and fixes — what failed, the root cause, how it was resolved (or not).
5. Done so far — completed steps, with verification results.
6. Pending — remaining tasks, open questions, anything promised to the user.
7. Current state and next step — exactly what was being done in the latest messages, and the \
very next action.

Be specific and dense (no filler). Never include secrets such as tokens or passwords; record \
where they live instead."""

COMPACTION_TEMPLATE = """\
[Context compacted: the earlier part of this conversation was summarized to fit the context \
window. The most recent messages follow verbatim after this one.]

<summary>
{summary}
</summary>
{user_messages}
The messages after this one are the latest steps, verbatim; their commands already ran and their \
outputs are current. Continue from the last of them: do not redo completed steps and do not ask \
the user to repeat themselves."""


def text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text") or b.get("thinking") or "" for b in content if isinstance(b, dict))
    return ""


def message_chars(message: dict) -> int:
    """Size proxy of one message on the wire (content + tool calls)."""
    chars = len(text_of(message.get("content"))) + 16
    if message.get("tool_calls"):
        chars += len(json.dumps(message["tool_calls"]))
    return chars


def messages_chars(messages: list[dict]) -> int:
    return sum(message_chars(m) for m in messages)


def prompt_tokens(message: dict) -> int | None:
    """Tokens the provider counted for the prompt that produced `message` (cached included)."""
    response = message.get("extra", {}).get("response")
    usage = response.get("usage") if isinstance(response, dict) else None
    if not isinstance(usage, dict):
        return None
    if isinstance(usage.get("prompt_tokens"), int):
        return usage["prompt_tokens"]
    if isinstance(usage.get("input_tokens"), int):  # Messages / Responses API
        return (
            usage["input_tokens"]
            + (usage.get("cache_read_input_tokens") or 0)
            + (usage.get("cache_creation_input_tokens") or 0)
        )
    return None


def cache_usage(message: dict) -> tuple[int, int, int]:
    """(prompt, cache read, cache write) tokens reported for the call behind `message`."""
    response = message.get("extra", {}).get("response")
    usage = response.get("usage") if isinstance(response, dict) else None
    if not isinstance(usage, dict):
        return 0, 0, 0
    details = usage.get("prompt_tokens_details") or usage.get("input_tokens_details") or {}
    read = usage.get("cache_read_input_tokens") or details.get("cached_tokens") or 0
    write = usage.get("cache_creation_input_tokens") or details.get("cached_creation_tokens") or 0
    return prompt_tokens(message) or 0, read, write


def _load_learned() -> dict:
    try:
        return json.loads(LEARNED_WINDOWS_FILE.read_text())
    except (OSError, ValueError):
        return {}


def context_window_for(model) -> int:
    """Context window of `model`: learned from an overflow error > model metadata > known ids."""
    config = getattr(model, "config", None)
    name = str(getattr(config, "model_name", "") or "")
    if learned := _load_learned().get(name.lower()):
        return int(learned)
    if isinstance(window := getattr(config, "context_window", 0), int) and window > 0:
        return window
    try:
        from minisweagent.models.opencode_go_model import get_model_info

        if info := get_model_info(name):
            return info.context_window
    except Exception:
        pass
    lowered = name.lower()
    return next((window for pattern, window in KNOWN_WINDOWS if re.search(pattern, lowered)), DEFAULT_WINDOW)


def is_context_overflow(error: Exception) -> bool:
    return bool(_OVERFLOW_PATTERNS.search(f"{type(error).__name__}: {error}"))


def learn_window(model, error: Exception) -> int | None:
    """Remember the real limit an overflow error reports, so later runs compact in time."""
    text = str(error)
    for pattern in _LIMIT_PATTERNS:
        if match := pattern.search(text):
            limit = int(match.groups()[-1].replace(",", ""))
            if limit < 1000:
                continue
            learned = _load_learned()
            learned[str(getattr(getattr(model, "config", None), "model_name", "")).lower()] = limit
            try:
                LEARNED_WINDOWS_FILE.write_text(json.dumps(learned, indent=1, sort_keys=True))
            except OSError:
                pass
            return limit
    return None


def head_length(messages: list[dict], max_chars: int) -> int:
    """Leading system messages plus the first task message (unless it alone is huge)."""
    n = 0
    while n < len(messages) and messages[n].get("role") == "system":
        n += 1
    if n < len(messages) and messages[n].get("role") == "user" and message_chars(messages[n]) <= max_chars:
        n += 1
    return n


def tail_start(messages: list[dict], lower: int, keep_chars: int) -> int:
    """Index where the verbatim tail begins: about `keep_chars` of the newest messages, never
    starting on a tool result (it must follow the assistant call it answers)."""
    start, total = len(messages), 0
    while start > lower and total + message_chars(messages[start - 1]) <= keep_chars:
        start -= 1
        total += message_chars(messages[start])
    while start < len(messages) and messages[start].get("role") == "tool":
        start += 1
    if start >= len(messages):  # the newest turn alone is over budget: keep just that turn
        start = len(messages) - 1
        while start > lower and messages[start].get("role") == "tool":
            start -= 1
    return max(start, lower)


def elide(message: dict, max_chars: int) -> dict:
    """Copy of `message` with its text content cut to `max_chars` (head and tail kept)."""
    text = text_of(message.get("content"))
    if len(text) <= max_chars or not isinstance(message.get("content"), str):
        return message
    half = max_chars // 2
    note = f"\n[... {len(text) - max_chars} characters elided by context compaction ...]\n"
    return {**message, "content": text[:half] + note + text[-half:]}


def shrink(messages: list[dict], protect_head: int, budget_chars: int) -> list[dict]:
    """Fit `messages` into `budget_chars` for the summarizer: elide the oldest long contents
    first, then drop the oldest middle turns. Loses cache reuse, used only past the limit."""
    out = list(messages)
    for cap in (8000, 2000, 400):
        for i in range(protect_head, len(out)):
            if messages_chars(out) <= budget_chars:
                return out
            out[i] = elide(out[i], cap)
    while messages_chars(out) > budget_chars and len(out) > protect_head + 2:
        del out[protect_head]
        while len(out) > protect_head + 1 and out[protect_head].get("role") == "tool":
            del out[protect_head]
    return out


def user_requests(messages: list[dict]) -> list[str]:
    """User-authored prompts among `messages` (tasks and follow-ups), oldest first."""
    requests = []
    for message in messages:
        extra = message.get("extra", {})
        if "compaction" in extra:
            requests.extend(extra["compaction"].get("user_messages", []))
        elif message.get("role") == "user" and extra.get("interrupt_type") in ("UserNewTask", "UserInterruption"):
            requests.append(text_of(message.get("content")).removeprefix("The user added a new task: "))
    return requests


def cap_requests(requests: list[str], per_message: int = 3000, total: int = 30000) -> list[str]:
    """Most recent requests first in the budget; the first one always survives."""
    clipped = [r if len(r) <= per_message else r[:per_message] + " [...]" for r in requests]
    kept, size = [], 0
    for request in reversed(clipped[1:]):
        if size + len(request) > total:
            break
        kept.append(request)
        size += len(request)
    return clipped[:1] + list(reversed(kept))


def render_compaction(summary: str, requests: list[str]) -> str:
    block = ""
    if requests:
        block = "\nUser messages from the summarized part, verbatim (oldest first):\n" + "\n".join(
            f"- {r.strip()}" for r in requests
        ) + "\n"
    return COMPACTION_TEMPLATE.format(summary=summary.strip(), user_messages=block)


def fallback_summary(messages: list[dict], max_chars: int = 12000) -> str:
    """Deterministic summary for when the summarizer call fails: the latest assistant notes."""
    notes = []
    for message in reversed(messages):
        if message.get("role") == "assistant" and (text := text_of(message.get("content")).strip()):
            notes.append(text[:1500])
            if sum(map(len, notes)) > max_chars:
                break
    return "(Automatic summary unavailable; latest assistant notes, oldest first.)\n\n" + "\n\n".join(reversed(notes))
