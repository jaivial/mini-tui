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

## 4. Direct OpenAI-compatible client for the gateways (no litellm)

`src/minisweagent/models/openai_compat_model.py` + `models/routing.py`.

`cliproxy/`, `rosetta/` and `xiaomi/` models are plain OpenAI `/chat/completions` gateways that
report no prices, so litellm only added its import cost: **~198 MB RSS and ~2 s per run**.
`OpenaiCompatModel` is the standard library's `http.client` plus pydantic and produces exactly the
message shape `LitellmModel` did (`tool_calls`, `extra.actions`, `extra.response` as a dict,
`extra.cost = 0.0`, plain-text final answers as `extra.submission`).

- Only protocol keys go on the wire (`role`, `content`, `tool_calls`, `tool_call_id`, `name`);
  litellm-only `model_kwargs` (`drop_params`, `custom_llm_provider`, …) are ignored.
- 400/401/403/404/413/422 abort at once (`OpenaiCompatAbortError`); 408/429/5xx and transport
  errors go through the usual tenacity retry.
- The API key is never serialized into the trajectory (`api_key: "***"`).
- `models/routing.py` holds the `is_*_model` prefix predicates, so `get_model_class` picks a
  gateway without importing any litellm-backed module (the provider modules re-export them).

DeepSeek, OpenAI and OpenCode Go stay on litellm: they rely on its price tables and on the
Anthropic/Responses protocol adapters.

Measured (same task, real cli-proxy): peak RSS 214 → 40 MB · first journal write 5.2 → 3.0 s.

## 5. Per-step overhead (0.8.0)

Measured with the deterministic model on a 600-step run (the agent's time besides the LLM and
the command): **8.9 → 1.8 ms/step**.

| Cost per step (before) | Fix |
| --- | --- |
| `gc.collect()` full pass: ~5–6 ms, growing with the heap | generation 0 every step, full every 50 (`FULL_GC_EVERY_STEPS`) |
| `Template(src)` parse+compile: ~1.5 ms × each render | `models/utils/templates.py`: `lru_cache` of compiled templates |
| Full export every 20 msgs / 10 s: O(n), 33 ms at 900 msgs | cadence `max(20, n // 10)` messages / 60 s; the journal is always current |
| New TCP (+TLS) connection per model call | keep-alive `http.client` connection per model, one retry on a stale socket |

## 6. Direct model clients — no litellm (0.9.0)

Since 0.9.0 every provider is reached through **its own direct base URL** with zero litellm
imports on any run path (litellm stays an optional `mini-swe-agent[litellm]` extra behind the
opt-in `--model-class litellm`). The pattern §4 established for the gateways now covers all
providers:

- **Three thin clients, one message contract.** `models/openai_compat_model.py` (OpenAI
  `/chat/completions` — DeepSeek, OpenAI, Moonshot, Zhipu, Groq, Z.AI, MiniMax, OpenRouter,
  the gateways), `models/anthropic_compat_model.py` (`/v1/messages` — `anthropic/*` and
  OpenCode Go's Anthropic flavor, with cache markers and thinking-block replay) and
  `models/responses_compat_model.py` (`/responses` — `gpt-6*` and OpenCode Go's Responses
  flavor). All three produce the exact message/trajectory shape `LitellmModel` did
  (`tool_calls`, `extra.actions`, `extra.response` dict, `extra.cost`, plain-text final
  answers as `extra.submission`), so the journal, `--resume` and the TUI are unchanged.
- **`models/providers.py`** — the provider registry: one row of (prefix, base URL + env,
  key env, protocol). Lookups are import-light (like `routing.py`), every provider has its
  own env slot, and unknown names fall back to the generic OpenAI-compatible client
  (`OPENAI_API_BASE`, `MSWEA_OPENAI_*` wins).
- **`models/prices.py`** replaces litellm's price tables: per-provider rows in $/1M tokens
  (input, output, cache read/write, tiered pricing for OpenCode Go), unknown ids cost 0.0
  like before, and `MSWEA_PRICE_TABLE_PATH` loads extra rows
  (`{provider: {id: [in, out, cache_read, cache_write]}}`).
- **`models/errors.py`** replaces litellm's exception taxonomy: `ProviderError` /
  `ProviderAbortError`, status-based abort-vs-retry classification shared by all clients.
  Provider error bodies stay raw and short (they surface in mini-tui's `mini.log tail`).
- The per-provider quirks carry over unchanged: DeepSeek's id aliases and error rewrites,
  OpenAI's temperature fallback and `gpt-6*` → Responses routing, OpenCode Go's per-id
  endpoint catalog and `x-opencode-session` header.


## 7. Integrated mini-tui runner (0.13.0)

Added `minisweagent.run.tui` and the `mini-swe-agent-tui` console entry point. It is deliberately
narrow: it accepts the yolo flags emitted by mini-tui, shares `run/config.py` with the public
Typer CLI, constructs the same agent/environment/model objects, and delegates trajectory writes
and control-channel behavior to the existing agent loop. Unlike the public command, it does not
import Typer, Rich, prompt-toolkit, or the interactive agent on its normal path. A missing entry
point is a capability-probe failure in `src/mini/spawn.ts`, which falls back to `mini`; the
protocol and artifacts do not change.

The runner also moves the benchmark-only `datasets` dependency behind the `benchmarks` extra and
removes the unused default `openai` SDK. The direct provider clients use standard-library HTTP
clients instead. `agent/setup.py` is a legacy-pip compatibility shim; canonical metadata remains
in `agent/pyproject.toml`.

## 8. Automatic context compaction and prompt-cache breakpoints

Long sessions used to die with `HTTP 400 ... prompt is too long: 1000243 tokens > 1000000
maximum`: every message was sent on every call and nothing bounded it.

**Compaction** (`agents/utils/compaction.py`, `DefaultAgent._query_model/compact`):

- The trajectory stays append-only. A compaction *appends* a `user` message with
  `extra.interrupt_type = "Compaction"` and `extra.compaction = {head, tail_messages, reason,
  tokens_before, context_window, summarized_messages, user_messages, summary_usage}`.
- The model is sent a view: head (system + first task message) + latest summary + the verbatim
  tail it kept + everything after. `--resume` rebuilds the same view (positions are relative).
- Trigger: `min(window * threshold, window - reserve_tokens)` estimated prompt tokens. The
  estimate is chars × a tokens/char ratio calibrated from the provider's `usage` of the
  previous call (`extra.context_chars` records the prompt size behind each reply).
- The summarizer call is the current view + one instruction, so it hits the prompt cache of
  the previous step. It keeps goals, every user request (also copied verbatim, capped),
  facts, files, errors, progress, and the next step. It falls back to a deterministic summary
  if the call fails.
- Safety net: a context-overflow error compacts and retries once. The real limit parsed from
  the error is saved in `<global config>/context_windows.json`, so later runs compact in time.
  A single output bigger than the window is elided in the request only.
- Windows: learned > `model.context_window` > OpenCode Go metadata > known ids (Claude 4.6+/5
  = 1M, older Claude 200k, GPT-5 400k, ...).

Knobs (`agent.compaction` in the config, or env): `enabled` (`MSWEA_AUTO_COMPACT=0` turns it
off), `threshold` (`MSWEA_COMPACT_THRESHOLD`, 0.8), `max_context_tokens`
(`MSWEA_COMPACT_MAX_TOKENS`, compact earlier than the window, which is cheaper and faster),
`reserve_tokens` (32000), `keep_recent_tokens` (0 = 10 % of the trigger, max 60k).

**Cache** (`models/utils/cache_control.py`, `set_cache_control: rolling`): at most 4
breakpoints on the head end, the latest compaction summary, the end of the previous step,
and the last message. The head survives compactions, and the previous-step mark makes the
read independent of Anthropic's 20-block lookback (turns with many tool results). Rolling
is the default for Claude on cli-proxy (which forwards `cache_control`, verified live) and for
Anthropic direct. Rosetta keeps no markers. `MSWEA_CACHE_TTL=1h` forwards a TTL.
The TUI shows compactions as `→ context · compacted (auto): 812k tokens of 1000k window, ...`.

## 9. `/compact`, control `COMPACT`, `--compact-only` (0.15.0)

- Control file line `COMPACT`: `_drain_control` sets `_compact_requested`, and
  `_apply_pending_compaction` runs `compact(reason="manual")` before the next model call (or
  while waiting at exit). Manual compaction keeps at most 25 % of the context verbatim. A
  conversation too short to summarize gets a `CompactionSkipped` marker, so the TUI never hangs
  on "Compacting...".
- `info.compacting` ("auto" | "overflow" | "manual" | "") is written to the journal before
  the summary call and cleared after it.
- `mini-swe-agent-tui --resume <file> --compact-only`: compact the saved conversation, then
  hold at exit for the next control `MESSAGE` (`DefaultAgent.run(compact_only=True)`).
- Journal fix: popping the exit message before the control wait rewinds `_journaled_messages`,
  so the next message is appended (before, the index skipped it).
