"""Basic agent class. See https://mini-swe-agent.com/latest/advanced/control_flow/ for visual explanation
or https://minimal-agent.com for a tutorial on the basic building principles.
"""

import gc
import json
import logging
import os
import time
import traceback
from pathlib import Path

from minisweagent.models.utils.templates import render as render_template
from pydantic import BaseModel

from minisweagent import Environment, Model, __version__
from minisweagent.exceptions import FormatError, InterruptAgentFlow, LimitsExceeded, Submitted, TimeExceeded
from minisweagent.utils.serialize import recursive_merge
from minisweagent.agents.utils import compaction as cmp


class CompactionConfig(BaseModel):
    """Automatic context compaction (see `agents/utils/compaction.py`)."""

    enabled: bool = os.getenv("MSWEA_AUTO_COMPACT", "1") != "0"
    threshold: float = float(os.getenv("MSWEA_COMPACT_THRESHOLD", "0.8"))
    """Compact once the estimated prompt reaches this fraction of the context window."""
    max_context_tokens: int = int(os.getenv("MSWEA_COMPACT_MAX_TOKENS", "0"))
    """Compact at this many prompt tokens even if the window is larger (0 = window only)."""
    reserve_tokens: int = 32000
    """Headroom always kept below the window for the reply (and the summary)."""
    keep_recent_tokens: int = 0
    """Newest messages kept verbatim after a compaction (0 = 10 % of the trigger, max 60k)."""


class AgentConfig(BaseModel):
    """Check the config files in minisweagent/config for example settings."""

    system_template: str
    """Template for the system message (the first message)."""
    instance_template: str
    """Template for the first user message specifying the task (the second message overall)."""
    step_limit: int = 0
    """Maximum number of steps the agent can take."""
    cost_limit: float = 3.0
    """Stop agent after exceeding (!) this cost."""
    wall_time_limit_seconds: int = 0
    """Stop agent after this many seconds of wall-clock time. 0 means no limit."""
    max_consecutive_format_errors: int = 3
    """Exit after this many format errors in a row (0 = no limit)."""
    output_path: Path | None = None
    """Save the trajectory to this path."""
    compaction: CompactionConfig = CompactionConfig()


class DefaultAgent:
    def __init__(self, model: Model, env: Environment, *, config_class: type = AgentConfig, **kwargs):
        """See the `AgentConfig` class for permitted keyword arguments."""
        self.config = config_class(**kwargs)
        self.messages: list[dict] = []
        self.model = model
        self.env = env
        self.extra_template_vars = {}
        self.logger = logging.getLogger("agent")
        self.cost = 0.0
        self.n_calls = 0
        self.n_consecutive_format_errors = 0
        self._start_time = time.time()
        # Append-only journal bookkeeping (see save()).
        self._journal_path: Path | None = None
        self._journaled_messages = 0
        self._export_messages = 0
        self._export_at = 0.0

    def get_template_vars(self, **kwargs) -> dict:
        return recursive_merge(
            self.config.model_dump(),
            self.env.get_template_vars(),
            self.model.get_template_vars(),
            {
                "n_model_calls": self.n_calls,
                "model_cost": self.cost,
                "elapsed_seconds": int(time.time() - self._start_time),
            },
            self.extra_template_vars,
            kwargs,
        )

    #: A full `gc.collect()` walks every tracked object (~6 ms/step on a long run, most of the
    #: agent's own overhead); generation 0 each step catches the per-step payloads, and the
    #: full pass every `FULL_GC_EVERY_STEPS` still bounds hour-long runs.
    FULL_GC_EVERY_STEPS = 50

    def _collect_garbage(self) -> None:
        self._gc_steps = getattr(self, "_gc_steps", 0) + 1
        gc.collect(2 if self._gc_steps % self.FULL_GC_EVERY_STEPS == 0 else 0)

    def _render_template(self, template: str) -> str:
        return render_template(template, **self.get_template_vars())

    @staticmethod
    def _tool_call_ids(message: dict) -> list[str]:
        """IDs of OpenAI-style tool calls carried by an assistant message."""
        return [str(call.get("id")) for call in message.get("tool_calls", []) if call and call.get("id")]

    @staticmethod
    def _synthetic_tool_results(pending: set[str]) -> list[dict]:
        """Build deterministic placeholder results for unanswered tool-call IDs."""
        return [
            {
                "role": "tool",
                "tool_call_id": call_id,
                "content": "Tool call was interrupted before execution; no result was available.",
                "extra": {
                    "raw_output": "",
                    "returncode": -1,
                    "exception_info": "action was not executed",
                    "interrupted": True,
                },
            }
            for call_id in sorted(pending)
        ]

    def _repair_tool_call_history(self, messages: list[dict]) -> list[dict]:
        """Make assistant tool calls answerable without changing valid message order.

        The normal agent loop adds observations before its next user turn. A live TUI
        follow-up, an interrupted command, or an old saved trajectory can instead leave
        an assistant ``tool_calls`` entry adjacent to a user turn. Claude's Messages API
        rejects that boundary. Synthetic tool results are inserted only at such
        boundaries; existing results and the append-only log are otherwise preserved.
        """
        repaired: list[dict] = []
        pending: set[str] = set()
        for message in messages:
            if not isinstance(message, dict):
                continue
            role = message.get("role")
            if role == "assistant":
                if pending:
                    repaired.extend(self._synthetic_tool_results(pending))
                pending = set(self._tool_call_ids(message))
                repaired.append(message)
            elif role == "tool":
                pending.discard(str(message.get("tool_call_id") or ""))
                repaired.append(message)
            else:
                if pending:
                    repaired.extend(self._synthetic_tool_results(pending))
                    pending.clear()
                repaired.append(message)
        if pending:
            repaired.extend(self._synthetic_tool_results(pending))
        return repaired

    def add_messages(self, *messages: dict) -> list[dict]:
        self.logger.debug(messages)  # set log level to debug to see
        prepared = list(messages)
        # Keep the append-only trajectory, but never let a control-file follow-up (or
        # another user interruption) split a tool call from its result on replay.
        self.messages.extend(self._close_unanswered_tool_calls(self.messages, prepared))
        self.messages.extend(prepared)
        return prepared

    @staticmethod
    def _close_unanswered_tool_calls(previous: list[dict], additions: list[dict]) -> list[dict]:
        """Return placeholders for pending calls before the first non-tool addition."""
        if not previous or not additions:
            return []
        first = additions[0]
        if first.get("role") != "user" or previous[-1].get("role") != "assistant":
            return []
        pending = set(DefaultAgent._tool_call_ids(previous[-1]))
        return DefaultAgent._synthetic_tool_results(pending) if pending else []

    def handle_uncaught_exception(self, e: Exception) -> list[dict]:
        return self.add_messages(
            self.model.format_message(
                role="exit",
                content=str(e),
                extra={
                    "exit_status": type(e).__name__,
                    "submission": "",
                    "exception_str": str(e),
                    "traceback": traceback.format_exc(),
                },
            )
        )

    def run(self, task: str = "", *, resume_messages: list[dict] | None = None, compact_only: bool = False, **kwargs) -> dict:
        """Run step() until agent is finished. Returns dictionary with exit_status, submission keys.

        ``resume_messages`` continues an earlier conversation: its message history is
        reloaded as context (exit markers dropped) and ``task`` arrives as a follow-up.
        """
        self.extra_template_vars |= {"task": task, **kwargs}
        if compact_only and not resume_messages:
            raise ValueError("compact_only requires resume_messages")
        if resume_messages:
            # Older saved trajectories can contain a tool call with no result (for
            # example, a run interrupted before the environment observation was appended).
            # Repair that boundary before adding any new user follow-up; otherwise Claude's
            # Messages API rejects the next request with a 400.
            self.messages = self._repair_tool_call_history(
                [m for m in resume_messages if m.get("role") != "exit"]
            )
            if compact_only:
                # `/compact` with no run in flight: compact the saved conversation, then hold at exit
                # for the next prompt (or stop) exactly like a finished turn.
                self._compact_requested = True
                self._apply_pending_compaction()  # its save() starts a fresh journal from the resumed log
                if not self._wait_for_control_followup():
                    self.save(self.config.output_path)
                    return (self.messages[-1] if self.messages else {}).get("extra", {})
            else:
                self.add_messages(self._user_task_message(task))
        else:
            self.messages = []
            self.add_messages(
                self.model.format_message(role="system", content=self._render_template(self.config.system_template)),
                self.model.format_message(role="user", content=self._render_template(self.config.instance_template)),
            )
        # The task must reach the journal before the first model call: the TUI (and any
        # `view --follow`) shows the prompt immediately instead of with the first reply.
        self.save(self.config.output_path, force=False)
        while True:
            try:
                self.step()
                self.n_consecutive_format_errors = 0  # reset on any clean step
            except FormatError as e:
                # The call was billed before parsing failed, so query() never got to charge it.
                self.cost += e.messages[0].get("extra", {}).get("cost", 0.0)
                self.n_consecutive_format_errors += 1
                if 0 < self.config.max_consecutive_format_errors <= self.n_consecutive_format_errors:
                    self.add_messages(
                        *e.messages,
                        {
                            "role": "exit",
                            "content": "RepeatedFormatError",
                            "extra": {"exit_status": "RepeatedFormatError", "submission": ""},
                        },
                    )
                else:
                    self.add_messages(*e.messages)
            except InterruptAgentFlow as e:
                self.add_messages(*e.messages)
            except Exception as e:
                self.handle_uncaught_exception(e)
                raise
            finally:
                # force=False: the journal is always current; the full export throttles.
                self.save(self.config.output_path, force=False)
                self._collect_garbage()
            if self.messages[-1].get("role") == "exit":
                exit_message = self.messages.pop()
                # The journal already holds the exit line: whatever comes next must still be
                # appended after it (the index would otherwise skip the next message).
                self._journaled_messages = min(self._journaled_messages, len(self.messages))
                # A TUI can hold the run open at exit and keep one conversation going:
                # a follow-up prompt continues where we left off (context preserved).
                if self._wait_for_control_followup():
                    continue
                self.messages.append(exit_message)
                break
        return self.messages[-1].get("extra", {})

    def step(self) -> list[dict]:
        """Query the LM, execute actions.

        A response without actions carries `extra.submission`: the model answered in
        plain text, which ends the run as a submission (no tool-call round-trip needed).
        """
        message = self.query()
        submission = message.get("extra", {}).get("submission")
        if isinstance(submission, str):
            raise Submitted(
                {
                    "role": "exit",
                    "content": submission,
                    "extra": {"exit_status": "Submitted", "submission": submission},
                }
            )
        return self.execute_actions(message)

    def _control_file(self) -> str | None:
        return os.environ.get("MSWEA_CONTROL_FILE")

    def _drain_control(self) -> tuple[str | None, list[str]]:
        """Read and consume the control file (TUI command channel).

        Returns `(model_name, user_messages)`. The file is truncated on read, so
        `MESSAGE` lines are consumed exactly once. Writing side: append lines
        `MODEL <name>` / `MESSAGE <text>` / `COMPACT` (compact the context now; it sets
        `self._compact_requested`, applied by `_apply_pending_compaction`).
        """
        control_path = self._control_file()
        if not control_path:
            return None, []
        path = Path(control_path)
        try:
            raw = path.read_text()
        except OSError:
            return None, []
        if not raw.strip():
            return None, []
        try:
            path.write_text("")
        except OSError:
            pass
        model_name = None
        messages = []
        for line in raw.splitlines():
            line = line.strip()
            if line == "COMPACT":
                self._compact_requested = True
            elif line.startswith("MODEL "):
                model_name = line[len("MODEL ") :].strip() or None
            elif line.startswith("MESSAGE "):
                payload = line[len("MESSAGE ") :].strip()
                if payload.startswith('"'):
                    # JSON-quoted so multi-line prompts survive the line-based protocol.
                    try:
                        payload = json.loads(payload)
                    except ValueError:
                        pass
                if payload:
                    messages.append(str(payload))
        return model_name, messages

    @staticmethod
    def _user_task_message(text: str) -> dict:
        """Same shape the interactive agent uses when the user adds a new task."""
        return {
            "role": "user",
            "content": f"The user added a new task: {text}",
            "extra": {"interrupt_type": "UserNewTask"},
        }

    def _apply_model_switch(self, name: str | None) -> None:
        if name and name != getattr(self, "_control_model_name", None):
            from minisweagent.models import get_model

            self._control_model_name = name
            self.model = get_model(name)

    def _apply_control_commands(self) -> None:
        """Apply out-of-band commands from MSWEA_CONTROL_FILE (e.g. a TUI `/model` switch).

        No-op unless the environment variable is set, so plain runs behave exactly as before.
        Supported lines: `MODEL <model name>` (applied before the next model call) and
        `MESSAGE <text>` (added to the conversation as a user follow-up).
        """
        model_name, messages = self._drain_control()
        self._apply_model_switch(model_name)
        self._apply_pending_compaction()
        for text in messages:
            self.add_messages(self._user_task_message(text))
        if messages:
            self.save(self.config.output_path, force=False)

    def _apply_pending_compaction(self) -> None:
        """Run a `/compact` requested over the control channel; always leaves a marker message."""
        if not getattr(self, "_compact_requested", False):
            return
        self._compact_requested = False
        if self.compact(reason="manual") is None:
            self.add_messages(
                {
                    "role": "user",
                    "content": "[Context compaction skipped: the conversation is too short to summarize.]",
                    "extra": {"interrupt_type": "CompactionSkipped", "timestamp": time.time()},
                }
            )
            self.save(self.config.output_path, force=False)

    def _wait_for_control_followup(self) -> bool:
        """Hold at exit for a follow-up prompt from the control channel.

        Lets a TUI keep one conversation going across submissions ("type to continue").
        Applies the queued commands and returns True when a `MESSAGE` arrived; only
        waits when MSWEA_CONTROL_FILE is set (the TUI ends the wait by killing us).
        """
        if not self._control_file():
            return False
        while True:
            model_name, messages = self._drain_control()
            self._apply_model_switch(model_name)
            self._apply_pending_compaction()
            if messages:
                for text in messages:
                    self.add_messages(self._user_task_message(text))
                self.save(self.config.output_path, force=False)
                return True
            time.sleep(0.2)

    def query(self) -> dict:
        """Query the model and return model messages. Override to add hooks."""
        self._apply_control_commands()
        if 0 < self.config.step_limit <= self.n_calls or 0 < self.config.cost_limit <= self.cost:
            raise LimitsExceeded(
                {
                    "role": "exit",
                    "content": "LimitsExceeded",
                    "extra": {"exit_status": "LimitsExceeded", "submission": ""},
                }
            )
        if 0 < self.config.wall_time_limit_seconds <= int(time.time() - self._start_time):
            raise TimeExceeded(
                {
                    "role": "exit",
                    "content": "TimeExceeded",
                    "extra": {"exit_status": "TimeExceeded", "submission": ""},
                }
            )
        self.n_calls += 1
        started = time.time()
        message = self._query_model()
        self.cost += message.get("extra", {}).get("cost", 0.0)
        # How long the model spent on this reply (chain-of-thought included): the TUI's
        # collapsed thinking block reads "Thought for {n} seconds" from it.
        message.setdefault("extra", {})["thinking_seconds"] = round(time.time() - started, 1)
        self.add_messages(message)
        return message

    # --- context compaction ---------------------------------------------------------------

    def _context_indices(self) -> list[int]:
        """Indices of `self.messages` the model sees: all of them until the first compaction,
        then head + latest compaction summary + its verbatim tail + everything after."""
        last = next((i for i in range(len(self.messages) - 1, -1, -1) if "compaction" in self.messages[i].get("extra", {})), None)
        if last is None:
            return list(range(len(self.messages)))
        info = self.messages[last]["extra"]["compaction"]
        head = info["head"]
        start = max(last - info["tail_messages"], head)
        tail = [i for i in range(start, len(self.messages)) if i != last and "compaction" not in self.messages[i].get("extra", {})]
        return [*range(head), last, *tail]

    def context_messages(self) -> list[dict]:
        """The (possibly compacted) conversation sent to the model."""
        return [self.messages[i] for i in self._context_indices() if self.messages[i].get("role") != "exit"]

    def _tokens_per_char(self, view: list[dict]) -> float:
        """Tokens per character of this conversation, from the provider's reported usage.

        Each reply records the size of the prompt that produced it (`extra.context_chars`), so
        the ratio stays exact after compactions and across `--resume`. Older replies without it
        only count while no compaction happened (their prompt was exactly `view[:j]`)."""
        if getattr(self, "_calibration", None):
            return self._calibration
        compacted = any("compaction" in m.get("extra", {}) for m in view)
        for j in range(len(view) - 1, 0, -1):
            extra = view[j].get("extra", {})
            if view[j].get("role") != "assistant" or not (tokens := cmp.prompt_tokens(view[j])):
                continue
            if chars := extra.get("context_chars"):
                return tokens / chars
            if not compacted:
                return tokens / max(cmp.messages_chars(view[:j]), 1)
        return 1 / cmp.DEFAULT_CHARS_PER_TOKEN

    def _compaction_trigger(self) -> int:
        cfg, window = self.config.compaction, cmp.context_window_for(self.model)
        trigger = min(int(window * cfg.threshold), window - cfg.reserve_tokens)
        if cfg.max_context_tokens:
            trigger = min(trigger, cfg.max_context_tokens)
        return max(trigger, 4000)

    def _maybe_compact(self) -> None:
        if not self.config.compaction.enabled:
            return
        view = self.context_messages()
        estimate = int(cmp.messages_chars(view) * self._tokens_per_char(view))
        if estimate >= self._compaction_trigger():
            self.compact(reason="auto", estimated_tokens=estimate)

    def compact(self, *, reason: str = "manual", estimated_tokens: int = 0, overflow: bool = False) -> dict | None:
        """Summarize the older part of the context into one appended `user` message.

        The summarizer request is the current context plus one instruction, so it reuses the
        prompt cache of the previous step; the head (system + task) stays byte-identical.
        """
        indices = self._context_indices()
        view = [self.messages[i] for i in indices]
        tpc = self._tokens_per_char(view)
        trigger = self._compaction_trigger()
        head = cmp.head_length(self.messages, max_chars=int(trigger * 0.1 / tpc))
        lower = head + (1 if indices[head:head + 1] and "compaction" in self.messages[indices[head]].get("extra", {}) else 0)
        keep = self.config.compaction.keep_recent_tokens or min(60000, int(trigger * 0.1))
        if reason == "manual":  # the user asked: summarize most of it, whatever the size
            keep = min(keep, int(cmp.messages_chars(view) * tpc * 0.25))
        tail_pos = cmp.tail_start(view, lower, int(keep / tpc))
        if tail_pos <= lower and not overflow:
            return None  # nothing old enough to summarize
        request = view
        if overflow or estimated_tokens > trigger + self.config.compaction.reserve_tokens // 2:
            request = cmp.shrink(view, lower, int(trigger / tpc))
        request = [*request, {"role": "user", "content": cmp.SUMMARY_PROMPT}]
        summary_message, summary = None, ""
        self._compacting = reason
        self.save(self.config.output_path, force=False)  # the journal's info line tells the TUI
        for attempt in range(2):
            try:
                summary_message = self.model.query(request)
                summary = cmp.text_of(summary_message.get("content")).strip()
                break
            except Exception as e:
                if getattr(e, "messages", None):  # FormatError: a tool call instead of text
                    summary = cmp.text_of(e.messages[0].get("content")).strip()
                    break
                if attempt or not cmp.is_context_overflow(e):
                    self.logger.warning("compaction summary failed: %s", e)
                    break
                cmp.learn_window(self.model, e)
                request = [*cmp.shrink(request[:-1], lower, int(trigger / tpc / 2)), request[-1]]
        self._compacting = None
        if summary_message:
            self.cost += summary_message.get("extra", {}).get("cost", 0.0)
        if len(summary) < 200:
            summary = cmp.fallback_summary(view[lower:tail_pos])
        requests = cmp.cap_requests(cmp.user_requests(view[head:tail_pos]))
        prompt, read, write = cmp.cache_usage(summary_message or {})
        tail_start = indices[tail_pos] if tail_pos < len(indices) else len(self.messages)
        # Relative to the summary's own index: `--resume` drops exit markers, which shifts
        # absolute positions but never the messages between the tail and the summary.
        tail_messages = len(self.messages) - tail_start
        message = {
            "role": "user",
            "content": cmp.render_compaction(summary, requests),
            "extra": {
                "interrupt_type": "Compaction",
                "compaction": {
                    "head": head,
                    "tail_messages": tail_messages,
                    "reason": reason,
                    "tokens_before": estimated_tokens or int(cmp.messages_chars(view) * tpc),
                    "trigger_tokens": trigger,
                    "context_window": cmp.context_window_for(self.model),
                    "summarized_messages": max(tail_pos - lower, 0),
                    "summary_usage": {"prompt": prompt, "cache_read": read, "cache_write": write},
                    "user_messages": requests,
                },
                "timestamp": time.time(),
            },
        }
        self.add_messages(message)
        self.save(self.config.output_path, force=False)
        return message

    def _query_model(self) -> dict:
        """Query with the compacted context; an overflow the estimate missed compacts and retries."""
        self._maybe_compact()
        view = self.context_messages()
        try:
            message = self.model.query(view)
        except Exception as e:
            if not self.config.compaction.enabled or not cmp.is_context_overflow(e):
                raise
            cmp.learn_window(self.model, e)
            if self.compact(reason="overflow", overflow=True) is None:
                raise
            view = self.context_messages()
            budget = int(self._compaction_trigger() / self._tokens_per_char(view))
            if cmp.messages_chars(view) > budget:  # e.g. one tool output larger than the window
                view = cmp.shrink(view, cmp.head_length(view, budget // 10) + 1, budget)
            message = self.model.query(view)
        chars = cmp.messages_chars(view)
        message.setdefault("extra", {})["context_chars"] = chars
        if tokens := cmp.prompt_tokens(message):
            self._calibration = tokens / max(chars, 1)
        return message

    def execute_actions(self, message: dict) -> list[dict]:
        """Execute actions in message, add observation messages, return them."""
        outputs = [self.env.execute(action) for action in message.get("extra", {}).get("actions", [])]
        return self.add_messages(*self.model.format_observation_messages(message, outputs, self.get_template_vars()))

    def serialize(self, *extra_dicts) -> dict:
        """Serialize agent state to a json-compatible nested dictionary for saving."""
        last_message = self.messages[-1] if self.messages else {}
        last_extra = last_message.get("extra", {})
        agent_data = {
            "info": {
                "model_stats": {
                    "instance_cost": self.cost,
                    "api_calls": self.n_calls,
                },
                "config": {
                    "agent": self.config.model_dump(mode="json"),
                    "agent_type": f"{self.__class__.__module__}.{self.__class__.__name__}",
                },
                "mini_version": __version__,
                "exit_status": last_extra.get("exit_status", ""),
                "submission": last_extra.get("submission", ""),
                "compacting": getattr(self, "_compacting", None) or "",
            },
            "messages": self.messages,
            "trajectory_format": "mini-swe-agent-1.1",
        }
        return recursive_merge(agent_data, self.model.serialize(), self.env.serialize(), *extra_dicts)

    # Full-export throttling: the append-only journal is always current, so the O(n) JSON
    # rewrite only has to land periodically and at the end of the run (any save() with the
    # default force=True still writes it immediately, keeping callers' semantics unchanged).
    EXPORT_EVERY_MESSAGES = 20
    EXPORT_EVERY_SECONDS = 60.0

    def _export_every_messages(self) -> int:
        """The full export is O(n) (~33 ms at 900 messages), so its cadence grows with the run:
        one rewrite per 10 % of new messages keeps the amortized cost per step constant. The
        journal stays the always-current, crash-safe copy either way."""
        return max(self.EXPORT_EVERY_MESSAGES, len(self.messages) // 10)

    def save(self, path: Path | None, *extra_dicts, force: bool = True) -> dict:
        """Save the trajectory of the agent to a file if path is given. Returns full serialized data.
        You can pass additional dictionaries with extra data to be (recursively) merged into the output data.

        Every message is also appended to ``<path>.jsonl`` (meta line, one line per message,
        fresh info line) as it happens — O(1) per step and never torn, so crash recovery and
        live consumers don't depend on the full rewrite. ``force=False`` throttles the full
        export to ``EXPORT_EVERY_MESSAGES``/``EXPORT_EVERY_SECONDS`` (it is always written
        when the run ends with an exit message).
        """
        data = self.serialize(*extra_dicts)
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
            self._append_journal(path, data)
            now = time.time()
            is_exit = bool(self.messages) and self.messages[-1].get("role") == "exit"
            if (
                force
                or is_exit
                or len(self.messages) - self._export_messages >= self._export_every_messages()
                or now - self._export_at >= self.EXPORT_EVERY_SECONDS
            ):
                tmp = path.with_name(path.name + ".tmp")
                tmp.write_text(json.dumps(data, separators=(",", ":")))
                os.replace(tmp, path)  # atomic: readers never see a torn trajectory
                self._export_messages = len(self.messages)
                self._export_at = now
        return data

    def _append_journal(self, path: Path, data: dict) -> None:
        """Keep ``<path>.jsonl`` (meta + one line per message + fresh info) up to date."""
        journal = path.with_suffix(".jsonl")
        fresh = self._journal_path != path or self._journaled_messages == 0
        lines: list[str] = []
        if fresh:
            self._journal_path = path
            self._journaled_messages = 0
            lines.append(
                json.dumps({"t": "meta", "trajectory_format": data.get("trajectory_format", "")}, separators=(",", ":"))
            )
        for message in self.messages[self._journaled_messages :]:
            lines.append(json.dumps({"t": "msg", "m": message}, separators=(",", ":")))
        self._journaled_messages = len(self.messages)
        lines.append(json.dumps({"t": "info", "i": data.get("info", {})}, separators=(",", ":")))
        with journal.open("w" if fresh else "a", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
