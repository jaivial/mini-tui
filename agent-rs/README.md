# mini-agent-rs

A Rust port of the [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) runner that
mini-tui drives (`agent/`, `minisweagent.run.tui`). It is a drop-in replacement: the same
command line, the same YAML configs and `~/.config/mini-swe-agent/.env`, the same
`<traj>.json` export and `<traj>.jsonl` journal, the same `MSWEA_CONTROL_FILE` protocol. mini-tui's
TUI, web app and headless mode read its output without knowing which agent produced it.

```sh
cd agent-rs && cargo build --release                 # target/release/mini-agent-rs
mini-tui                                             # uses it: the default once it is built
cargo build --release --target x86_64-unknown-linux-musl   # a static binary for any Linux box
```

mini-tui (the TUI, `-p` and the web app) runs this binary whenever it finds one: `MINITUI_AGENT_BIN`,
else this directory's release build, else `~/.local/lib/mini-tui/mini-agent-rs`, else `mini-agent-rs`
on `PATH`. With none, it uses Python. `MINITUI_AGENT=python` keeps Python; `MINITUI_AGENT=rust`
also warns when no binary is found. mini-tui sets `MINI_AGENT_CONFIG_DIR` to the bundled configs, so
an installed copy outside the checkout finds `mini.yaml`.

The binary also does the two one-shot jobs mini-tui used to run through Python, so with it no
Python is needed at all:
- `mini-agent-rs title "<task>" <model>` prints the session title as a JSON string
  (`scripts/gen_title.py`).
- `mini-agent-rs test-model <model>` is the providers panel's connection test
  (`scripts/test_model.py`): it prints `ok` and exits 0, or `error: …` and exits 1.
On a remote host, install the binary the same way; its `mini-tui -p` picks it up.

## What it does

The agent loop of `agents/default.py`:
- query, run the bash tool calls, format observations;
- step, cost and wall-time limits;
- repeated format errors;
- a plain-text reply is the final answer;
- the submit marker;
- `--resume`, with repair of unanswered tool calls;
- holding at exit for a follow-up;
- `MODEL` / `MESSAGE` / `COMPACT` control lines;
- automatic, manual and overflow context compaction;
- the always-current journal with throttled atomic exports;
- streamed partial output (`delta` lines).

Environments: `local` (the process group is killed on timeout or on stop) and `docker`.

Models, routed by name exactly like `get_model`:

| Names | Client |
| --- | --- |
| `cliproxy/…`, `rosetta/…`, `xiaomi/…`, `mimo…` | OpenAI chat completions (streamed) |
| `deepseek/…`, `deepseek…` (aliases resolved) | chat completions + DeepSeek error rewrites |
| `openai/…` (`gpt-6…` → Responses API) | chat completions / Responses, temperature fallback |
| `anthropic/…`, bare `claude…` | Anthropic Messages (rolling cache markers) |
| `moonshot/`, `zhipu/`, `groq/`, `zai/`, `minimax/`, `openrouter/` | the provider registry |
| `opencode-go/…` | chat / Messages / Responses per the Go table (`src/models/go_catalog.rs`) |
| anything else | generic OpenAI-compatible (`OPENAI_API_BASE`) |
| `model_class: deterministic…` | the scripted test models |

It also ports prices and cost tracking, the process-wide limits (`MSWEA_GLOBAL_COST_LIMIT`,
`MSWEA_GLOBAL_CALL_LIMIT`), the retry policy (`MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT`, with
tenacity's 4, 4, 4, 8, 16, 32, 60 second waits),
the abort-versus-retry classification of HTTP errors, and every `MSWEA_*` variable the Python
agent reads.

Not ported, because mini-tui never uses them:
- the litellm, portkey, requesty and openrouter-SDK model classes, and the regex text-based
  models;
- the singularity, bubblewrap, contree and swerex environments;
- the interactive (confirm-mode) agent (mini-tui always runs yolo on the direct clients);
- `mini-extra` (config, inspector, benchmarks, model listings) and the public Rich/Typer `mini`
  CLI.

Asking for one of these is an error that names what is supported.

## Parity with the Python agent

`tests/parity/` runs the same scripted task through both agents and diffs everything mini-tui
reads: every message, observation, info block and journal line, and the exit code. For the
HTTP clients it also diffs every request body sent to a scripted server. Timestamps and
durations are the only values normalized.

```sh
sh tests/parity/run_all.sh     # 26 scenarios + 8 helper cases; "ALL IDENTICAL" or the differences
cargo test --release           # unit tests
```

Scenarios:
- **Agent loop:** tools, stderr, Unicode, long output; step and cost limits; command timeout;
  missing files; the submit marker; the text model; resume; compact-only; follow-ups; `/compact`
  on a live run; `MODEL` switches; SIGINT and SIGTERM during a command and during a model call;
  the global cost and call limits; the shipped `mini.yaml`.
- **Helpers:** `title` and `test-model` against the Python scripts. Cases: clean text, whitespace,
  over-long titles, tool-call replies, empty replies, 401s. Stdout, exit code, stderr and the
  request must all match.
- **Wire protocols:** cli-proxy SSE with a 503 retry and a format error; Rosetta; DeepSeek aliases;
  the z.ai registry; OpenAI's temperature fallback; Anthropic Messages with the `tool_choice`
  retry; the Responses API; a 401 abort; OpenCode Go on all three endpoints.

Known differences, all deliberate:
- A tool call's argument-parsing error text comes from a different JSON decoder, so the model
  sees different wording; the structure is the same.
- `extra.traceback` on a crash is one line, not a Python stack.
- Replaying an Anthropic thinking block works. The Python agent crashes on it
  (`deepcopy` of its response wrapper: `'NoneType' object is not callable`).
