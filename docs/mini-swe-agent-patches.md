# Companion mini-swe-agent patches

`mini-tui` works with an unmodified
[mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent). Two small, optional patches to your
local checkout unlock the behaviors below. Both are inert unless you use them.

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

## 2. Control file (live `/model` switching)

`src/minisweagent/agents/default.py` — apply out-of-band commands before each model call:

```python
def _apply_control_commands(self) -> None:
    """Apply out-of-band commands from MSWEA_CONTROL_FILE (e.g. a TUI `/model` switch)."""
    control_path = os.environ.get("MSWEA_CONTROL_FILE")
    if not control_path:
        return
    try:
        lines = Path(control_path).read_text().splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line.startswith("MODEL "):
            continue
        name = line[len("MODEL ") :].strip()
        if name and name != getattr(self, "_control_model_name", None):
            from minisweagent.models import get_model

            self._control_model_name = name
            self.model = get_model(name)
```

Call it at the top of `DefaultAgent.query()`. Semantics:

- No-op unless `MSWEA_CONTROL_FILE` is set (mini-tui sets it per run), so plain `mini` runs behave
  exactly as before.
- Supported line: `MODEL <model name>` (last one wins; applied lazily before the next model call).
- The new model is built with `get_model(name)` defaults — exactly like starting `mini -m <name>`.

mini-tui writes `MODEL <id>` to `<session>/control` when you pick a model with `/model`, and the
header/transcript show the switch as `model → <id> (from next step)`.
