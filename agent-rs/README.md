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

## Subagents (`mini-agent-rs agent`)

Every run is also an orchestrator. It starts a small hub (a Unix socket its bash commands reach
through `MINI_AGENT_SOCKET`), so the model can split work across child agents that the session owns:

```sh
mini-agent-rs agent spawn api "write the API tests" --cwd ~/repo --max-steps 60
mini-agent-rs agent send api "also cover the 404 path"    # mid-run, or continue a finished one
mini-agent-rs agent ls | wait [--any] | result | tail | model | stop
mini-agent-rs agent ask "which branch?"                    # inside a child: message the parent
```

- **One process per child, for its whole life.** A child is an ordinary run with its control file
  kept open. When its turn ends it holds its context, so a follow-up is one `MESSAGE` line, not a
  new process replaying the history. A message sent mid-turn lands before its next model call.
  Children that exited (stopped, crashed, or the session restarted) continue from their saved
  conversation under the same name.
- **Reports without polling.** When a child finishes, fails, stalls (`MINI_AGENT_STALL_S`, 600 s)
  or asks something, the parent gets one `[subagent <name>] …` user message (`interrupt_type:
  Subagent`) before its next model call. A parent holding at its exit is woken by it. A turn the
  parent already saw (through `wait` or `result`) is not reported twice.
- **Owned.** Children stop with the parent (SIGINT, so they save). Their spend counts toward the
  parent's cost limit, and a child's budget is capped by what that limit has left. After
  `LimitsExceeded`, the next `send` gives the child another turn's budget (`STEPS` / `COST` control
  lines). Children run on the parent's current model unless `-m` or `agent model` says otherwise.
- **Visible.** `<traj dir>/subagents/index.json` lists the children, and `info.subagents` in the
  parent's trajectory does too. mini-tui saves each child as a session under its parent
  (`parent_id`) and announces its live agent: the web app shows a strip of subagents above the
  transcript, any of which opens (and follows live) in the pane; the TUI lists them with
  `/subagents` and opens them with `/resume`.
- **Bounded.** Up to 100 live children (`MINI_AGENT_MAX_SUBAGENTS`, clamped to 100), nesting 2 deep
  (`MINI_AGENT_MAX_DEPTH`). `MINI_AGENT_SUBAGENTS=0` turns the hub off. A run that starts no child
  writes exactly what the Python agent writes, so the parity suite is unaffected.
- **Within the free memory, never OOM.** `agent resources` reports the free memory, what an average
  live child costs (the rolling mean of sampled RSS of its process group, 256 MiB floor until one
  is measured) and `max fan-out now`:

      min((MemAvailable - reserve) / per-child, cpu-headroom, cap - live)

  with the reserve at 10 GiB by default (`MINI_AGENT_RESERVE_MEM_MB`). The same calculus is
  enforced at every `spawn`: a child that would not fit is refused with the numbers and exit 1,
  while the parent and the other children go on. The CPU term binds only when the 1-minute load is
  at or above the usable CPUs; subagents otherwise sit idle waiting for their next model call.

The bundled `$subagents` skill teaches the model this loop. The `orch` script of `$orchestration`
forwards `start` / `followup` / `ls` / `wait` / `result` / `stop` to it when it runs inside such a
session. Detached headless runs remain for your own terminal and the Python agent.

### DAG plans (`mini-agent-rs agent plan`)

A session can hand its hub a whole DAG and stop being the launcher: `agent plan submit --file
plan.json` validates the plan (unique ids, deps that exist, no cycles) and the hub's scheduler
launches each task the moment its deps are satisfied — even while the parent is in another turn —
within the memory/cost caps and one task per `group` at a time. Tasks carry `budget`
(steps/cost) and `artifacts` they commit to leave on disk; a successor is born with a `<handoff>`
block holding its deps' results and artifact contents. States: `pending -> running -> review`
(review satisfies successors; `plan review ok` marks `done`) `-> failed / blocked`. Re-plan in
flight with `plan add/rm/dep`, inspect with `plan show [--json]` / `plan graph`, relaunch with
`plan retry`; `[plan]` notes report everything. The plan lives in `subagents/plan.json` next to
`index.json`, so the UIs can draw it.

`spawn` can hand a child what the session already knows, so it does not pay the cold start:
`--context-file F` (repeatable) arrives as `<context>` blocks capped at 32 KiB together
(`MINI_AGENT_CONTEXT_MAX`), `--brief` validates and wraps a structured brief (goal, key paths,
conventions, searches done, decisions), and every run tree owns a shared append-only
`<run dir>/context/` folder (findings, artifacts, search caches) that each child is told about and
that grandchildren share too.

## Cold-start metrics (`mini-agent-rs metrics`)

`mini-agent-rs metrics <traj.jsonl> [--json]` measures how much of a run went to **re-discovery**:
every step is split into discovery (read-only commands: `ls`, `grep`, `cat`, `git log`…) and work
(edits, builds, tests), with estimated tokens for each, the commands it ran, and what a brief
handing the discoveries over would cost instead of re-discovering them. It only reads the journal
(a child's `traj.jsonl` works the same): no behavior changes. The numbers feed Fase 0 of
[`docs/orchestration-plan.md`](../docs/orchestration-plan.md).

## The RLM harness (`mini-agent-rs rlm`)

`rlm` is a Recursive Language Model harness in pure Rust: an execution framework that treats
long-horizon context as program variables and sub-agents as function calls, inside a persistent
REPL. The program is yours (a script or the interactive prompt); `ask` is one model turn and
`call` runs a whole sub-agent to completion and gives its answer back as a value, recursively.
It is experimental and lives behind this opt-in subcommand only — the orchestrator above does
not use it (the plan's Fase 6 gate: measure before adopting).

```sh
mini-agent-rs rlm                       # interactive (rlm>), state auto-saved at exit
mini-agent-rs rlm script.rlm            # run a script (exit 1 on the first error)
mini-agent-rs rlm -e 'let x = 1' -e 'show x'
printf 'let x = 2\nshow x\n' | mini-agent-rs rlm
```

```text
let repo = mini-tui              # context is variables; {{repo}} interpolates (strict Jinja)
def worker(q)                    # a sub-agent is a function call
let r = ask {{q}}                #   one turn: model + bash tool until it answers
return {{r}}                     #   the answer is the call's value
end
let out = call worker(check the tool)
let files = run ls               # shell in the session environment
```

One statement per line (`#` comments). An expression is text with `{{var}}` interpolation
(unknown variables are errors; `{{_}}` is the last value), or `ask …`, `call …`, `run …`
(prefix a literal with `\` to force it). `let` binds locally to the running function (or the
REPL), `set` binds a global; each `call` gets its own conversation and its parameters, so
functions recurse safely up to `--max-depth` (default 8, `MINI_RLM_MAX_DEPTH`).

| Statement | Meaning |
| --- | --- |
| `let NAME = EXPR` / `set NAME = EXPR` | bind a variable (local / global) |
| `ask TEXT` | one sub-agent turn on the current conversation (steps: `--step-limit`, 25) |
| `call NAME(args…)` | run a function: a whole sub-agent as a function call |
| `run SHELL` | run a shell command; its output is the value |
| `return EXPR` | end the current call with a value |
| `def NAME(p1, p2)` … `end` | define a function (a sub-agent program) |
| `vars` `show` `unset` `fns` `fn` | inspect the state |
| `model` `cost` `clear` `system` | the session: model, spend, conversation, prompt |
| `save` `load` | persist the state (variables + functions) to `--state`, or a path |
| `help` `quit` `exit` | — |

The state (`$MSWEA_GLOBAL_CONFIG_DIR/rlm.json`, or `--state`/`MINI_RLM_STATE`) auto-loads at
start and auto-saves at exit, so the REPL continues where it left off. `-c` YAML configs work
like a run's (`model`, `environment`), `-m` picks the model, and scripted `deterministic*`
models drive the tests. Recursion is capped (`max recursion depth`), a function that never
returns answers with its last value, and a sub-agent that never answers stops at the step
limit (`LimitsExceeded`).

## Parity with the Python agent

`tests/parity/` runs the same scripted task through both agents and diffs everything mini-tui
reads: every message, observation, info block and journal line, and the exit code. For the
HTTP clients it also diffs every request body sent to a scripted server. Timestamps and
durations are the only values normalized.

```sh
sh tests/parity/run_all.sh     # 28 scenarios + 8 helper cases; "ALL IDENTICAL" or the differences
cargo test --release           # unit tests
```

Scenarios:
- **Agent loop:** tools, stderr, Unicode, long output; step and cost limits; command timeout;
  missing files; the submit marker; the text model; resume; compact-only; follow-ups; `/compact`
  on a live run; `MODEL` switches; SIGINT and SIGTERM during a command and during a model call;
  the global cost and call limits; the shipped `mini.yaml`.
- **Turn and tool-call counting** (`turns.yaml`, `wire_batch.*`): a model that batches several
  independent commands into one reply must look the same to both agents — same turns, same tool
  calls, same prompts — so neither one makes the model do more work.
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
