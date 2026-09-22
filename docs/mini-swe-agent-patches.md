# Companion mini-swe-agent patches

These three patches are **already included** in the vendored `agent/` directory — this document
is the upstreamable description of the exact changes. `mini-tui` also works with an unmodified
[mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent); without the patches, everything
is inert except live `/model` switching, conversational follow-ups and `/resume`.

## 1. Plain-text final answer (no temporary markdown file)

Without this patch, the model can only submit through a bash call (`echo
COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`, optionally after writing its answer to a temp file). With
the patch, **a response with text and no tool calls is the final answer** and ends the run as a
submission, so the model simply answers.

`src/minisweagent/models/litellm_model.py` — detect a plain-text-only response and mark it:

```python
# in query(), before parsing actions:
final_answer = self._final_answer(response)
try:
    actions = [] if final_answer is not None else self._parse_actions(response)
except FormatError as e:
    ...
message["extra"] = {...}
if final_answer is not None:
    message["extra"]["submission"] = final_answer
```

```python
def _final_answer(self, response) -> str | None:
    """A response with text but no tool calls is the plain-text final answer."""
    message = response.choices[0].message
    if message.tool_calls:
        return None
    content = message.content
    if not isinstance(content, str):
        return None
    return content.strip() or None
```

`src/minisweagent/agents/default.py` — turn `extra.submission` into the run's submission:

```python
def step(self) -> list[dict]:
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
```

Finally, update the prompts in `src/minisweagent/config/mini.yaml` so every path agrees: mid-task
responses must contain a tool call, and the **final response is the answer as plain text** (remove
the `cat > /tmp/final_answer.md` / `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` instructions from
`response_format_rule`, `instance_template` and the command-rules section).

The legacy marker protocol keeps working unchanged.

## 2. Control file (live `/model` switching and follow-up prompts)

`src/minisweagent/agents/default.py` — a small out-of-band command channel, applied before each
model call and at exit:

```python
def _drain_control(self) -> tuple[str | None, list[str]]:
    """Read and consume the control file. Returns (model_name, user_messages)."""
    control_path = os.environ.get("MSWEA_CONTROL_FILE")
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
    model_name, messages = None, []
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
    model_name, messages = self._drain_control()
    self._apply_model_switch(model_name)
    for text in messages:
        self.add_messages(self._user_task_message(text))

def _wait_for_control_followup(self) -> bool:
    """Hold at exit so a TUI can continue the conversation ("type to continue")."""
    if not os.environ.get("MSWEA_CONTROL_FILE"):
        return False
    while True:
        model_name, messages = self._drain_control()
        self._apply_model_switch(model_name)
        if messages:
            for text in messages:
                self.add_messages(self._user_task_message(text))
            return True
        time.sleep(0.2)
```

Call `_apply_control_commands()` at the top of `DefaultAgent.query()`, and hold at exit in
`DefaultAgent.run()`:

```python
if self.messages[-1].get("role") == "exit":
    exit_message = self.messages.pop()
    if self._wait_for_control_followup():
        continue          # same conversation continues; the exit marker is dropped
    self.messages.append(exit_message)
    break
```

Semantics:

- No-op unless `MSWEA_CONTROL_FILE` is set (mini-tui sets it per run and appends `MODEL <id>` /
  `MESSAGE <text>` lines), so plain `mini` runs behave exactly as before.
- `MODEL <name>`: the running agent switches model from its next step (built with `get_model(name)`
  defaults — exactly like starting `mini -m <name>`).
- `MESSAGE <text>`: injected as a `UserNewTask` user message (the same shape
  `InteractiveAgent` uses), so follow-up prompts continue the same conversation — mid-run from
  the next step, or after a submission via the exit hold.
- The hold ends when the TUI kills the process (Ctrl+C / `q` in mini-tui).

## 3. `--resume` (true context carry-over)

Lets a run continue an earlier conversation with its full message history as context — this is
what makes `/resume` followed by a prompt feel like the same chat.

`src/minisweagent/agents/default.py` — `run()` learns `resume_messages`:

```python
def run(self, task: str = "", *, resume_messages: list[dict] | None = None, **kwargs) -> dict:
    self.extra_template_vars |= {"task": task, **kwargs}
    if resume_messages:
        # Continue an earlier conversation: keep its history (minus exit markers)
        # and deliver the new task as a follow-up.
        self.messages = [m for m in resume_messages if m.get("role") != "exit"]
        self.add_messages(self._user_task_message(task))
    else:
        self.messages = []
        self.add_messages(
            self.model.format_message(role="system", content=self._render_template(self.config.system_template)),
            self.model.format_message(role="user", content=self._render_template(self.config.instance_template)),
        )
    ...  # the step loop is unchanged
```

`src/minisweagent/run/mini.py` — a CLI flag (plus `import json`):

```python
resume: Path | None = typer.Option(
    None,
    "--resume",
    help="Continue an earlier conversation: reload the messages from this trajectory/JSON file "
    "as context and treat the task as a follow-up.",
    rich_help_panel="Advanced",
),
...
if resume is not None:
    resume_messages = json.loads(resume.read_text()).get("messages", [])
    agent.run(run_task, resume_messages=resume_messages)
else:
    agent.run(run_task)
```

Semantics: the file is any trajectory (or `{"messages": [...]}`) produced by a previous run;
`mini --resume <file> -t "follow-up"` reloads those messages (dropping `exit` markers) and adds
the new task as a `UserNewTask` follow-up — same shape the interactive agent uses. Verified
end-to-end: a run that learns a secret fact, then `--resume` with "what is my favorite color?",
answers from the earlier conversation.
