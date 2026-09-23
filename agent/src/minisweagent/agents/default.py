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

    def add_messages(self, *messages: dict) -> list[dict]:
        self.logger.debug(messages)  # set log level to debug to see
        self.messages.extend(messages)
        return list(messages)

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

    def run(self, task: str = "", *, resume_messages: list[dict] | None = None, **kwargs) -> dict:
        """Run step() until agent is finished. Returns dictionary with exit_status, submission keys.

        ``resume_messages`` continues an earlier conversation: its message history is
        reloaded as context (exit markers dropped) and ``task`` arrives as a follow-up.
        """
        self.extra_template_vars |= {"task": task, **kwargs}
        if resume_messages:
            self.messages = [m for m in resume_messages if m.get("role") != "exit"]
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
        `MODEL <name>` / `MESSAGE <text>`.
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
            if line.startswith("MODEL "):
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
        for text in messages:
            self.add_messages(self._user_task_message(text))
        if messages:
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
        message = self.model.query(self.messages)
        self.cost += message.get("extra", {}).get("cost", 0.0)
        # How long the model spent on this reply (chain-of-thought included): the TUI's
        # collapsed thinking block reads "Thought for {n} seconds" from it.
        message.setdefault("extra", {})["thinking_seconds"] = round(time.time() - started, 1)
        self.add_messages(message)
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
