# mini-agent-rs

A Rust port of the [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) runner that
mini-tui drives (`agent/`, `minisweagent.run.tui`). It is a drop-in replacement: the same
command line, the same YAML configs and `~/.config/mini-swe-agent/.env`, the same
`<traj>.json` export and `<traj>.jsonl` journal, the same `MSWEA_CONTROL_FILE` protocol. mini-tui's
TUI, web app and headless mode read its output without knowing which agent produced it.

```sh
cd agent-rs && cargo build --release                 # target/release/mini-agent-rs
MINITUI_AGENT=rust mini-tui                          # use it (the Python agent stays the default)
cargo build --release --target x86_64-unknown-linux-musl   # a static binary for any Linux box
```

`MINITUI_AGENT=rust` picks the binary from `MINITUI_AGENT_BIN`, else this directory's release
build, else `mini-agent-rs` on `PATH`. If none is found, mini-tui says so and uses Python.
On a remote host, set `MINITUI_AGENT=rust` in the environment its `mini-tui -p` runs with.

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

It also ports prices and cost tracking, the retry policy (`MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT`),
the abort-versus-retry classification of HTTP errors, and every `MSWEA_*` variable the Python
agent reads.

Not ported: the litellm, portkey, requesty and openrouter-SDK model classes; the singularity,
bubblewrap, contree and swerex environments; the interactive (confirm-mode) agent. mini-tui
never uses these (it always runs yolo on the direct clients). Asking for one is an error that
names what is supported.

## Parity with the Python agent

`tests/parity/` runs the same scripted task through both agents and diffs everything mini-tui
reads: every message, observation, info block and journal line, and the exit code. For the
HTTP clients it also diffs every request body sent to a scripted server. Timestamps and
durations are the only values normalized.

```sh
sh tests/parity/run_all.sh     # 24 scenarios; "ALL IDENTICAL" or the differences
cargo test --release           # unit tests
```

Scenarios:
- **Agent loop:** tools, stderr, Unicode, long output; step and cost limits; command timeout;
  missing files; the submit marker; the text model; resume; compact-only; follow-ups; `/compact`
  on a live run; `MODEL` switches; SIGINT and SIGTERM during a command and during a model call;
  the shipped `mini.yaml`.
- **Wire protocols:** cli-proxy SSE with a 503 retry and a format error; Rosetta; DeepSeek aliases;
  the z.ai registry; OpenAI's temperature fallback; Anthropic Messages with the `tool_choice`
  retry; the Responses API; a 401 abort; OpenCode Go on all three endpoints.

Known differences, all deliberate:
- A tool call's argument-parsing error text comes from a different JSON decoder, so the model
  sees different wording; the structure is the same.
- `extra.traceback` on a crash is one line, not a Python stack.
- Replaying an Anthropic thinking block works. The Python agent crashes on it
  (`deepcopy` of its response wrapper: `'NoneType' object is not callable`).
