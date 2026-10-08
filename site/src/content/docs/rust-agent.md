---
title: Python or Rust agent
description: The bundled Python mini-swe-agent or its Rust port, one static binary: how they compare, how to install the Rust agent with one command, and how to choose.
section: Start
order: 2
---

mini-tui drives a coding agent: the loop that asks the model, runs its commands and reports back. It
ships two interchangeable ones:

- **The Python agent:** the bundled [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent), installed with `pip`.
- **The Rust agent:** `mini-agent-rs`, a port of the same runner, as one self-contained binary.

Both read the same configs and `~/.config/mini-swe-agent/.env`, take the same command line, and write the
same trajectory and journal. They read the same control file, so `/model` and follow-ups work the same.
The terminal UI, `mini-tui -p` and the web app work with either one. A session started on one can be
resumed on the other.

## How they compare

Measured on one Linux box with the same scripted task (the parity suite's `basic` scenario), median of
five runs:

| | Python agent | Rust agent |
| --- | --- | --- |
| Start the runner | 65 ms | 0.7 ms |
| One scripted turn, start to finish | 661 ms | 51 ms |
| A session waiting for your next message | 35.7 MB | 4.5 MB |
| Needs | Python 3.10+ and the agent's packages | nothing: one 6.7 MB static binary |
| Install | `pip install -e ./agent` | download one file |
| Session titles and key tests | a Python helper each | built in (`title`, `test-model`) |

The memory line matters most in the web app. Every open session keeps an agent waiting for your next
message: ten idle sessions hold about 45 MB on Rust and about 357 MB on Python.

Model calls take the same time with both: the model is the slow part of a real turn. The Rust agent
saves the start-up, the time between steps, and the memory.

## "Does the Rust agent make more tool calls?"

No. The two agents send the model **byte-identical prompts**, so the model behaves the same with
both and neither one asks it to do more work. Two parity scenarios guard exactly that:

- `turns` — a model that batches several independent commands into one reply (what a real agent
  does after reading the repository). Both agents must take the same number of model turns, run
  the same tool calls, and write the same trajectory.
- `batch-calls` — the same over the wire, against a scripted HTTP server: every request body
  both agents send is compared byte for byte.

So the prompt, the tools, the observations, the limits, the compaction and the journal are the
same on both sides. The system prompt is read from the same `mini.yaml`, and the model is chosen
by mini-tui and passed to whichever agent runs.

If one run really does take more turns or more tool calls than another with the same task, the
difference is on the model side, not the agent's: the two are not deterministic. Sampling,
reasoning depth and server load decide how many commands a model chooses to batch per reply,
and a run that starts in a different session, at a different time, or with a different context
will naturally differ. What to check when it happens:

1. **Same model and config?** The two runs must use the same `-m` model and the same `-c` specs.
   `/model` in a session, `MININITUI_MODEL`, or a model with a smaller context window changes
   how much the model batches.
2. **Context pressure.** A run that gets near the window compacts (`/compact`, or automatic at
   80% of it). After a summary the model re-reads more and batches less, so it needs more turns.
   The transcript shows a "context compacted" line where that happened.
3. **Compare prompts, not vibes.** Both agents write the same trajectory format, so you can diff
   them: `~/.config/mini-tui/runs/<session>/traj.json` (or the `--print` stream). If the
   trajectories match turn for turn, the agents behaved identically.

Local overhead never adds tool calls: the Rust agent reaches its first model request in about
7 ms where Python takes about 173 ms, and it uses about 4.5 MB of memory for a waiting session
where Python uses about 35.7 MB.

## Install the Rust agent

The static build runs on any x86-64 Linux, with no Python needed. Put it where mini-tui looks for it:

```bash
mkdir -p ~/.local/lib/mini-tui
curl -fLo ~/.local/lib/mini-tui/mini-agent-rs \
  https://github.com/jaivial/mini-tui/releases/latest/download/mini-agent-rs-x86_64-linux-musl
chmod +x ~/.local/lib/mini-tui/mini-agent-rs
```

That is all: the next `mini-tui` uses it. To check the download first, compare it with the release's
checksums:

```bash
cd ~/.local/lib/mini-tui
curl -fsSLO https://github.com/jaivial/mini-tui/releases/latest/download/SHA256SUMS
grep linux-musl SHA256SUMS | sed 's/mini-agent-rs-x86_64-linux-musl/mini-agent-rs/' | sha256sum -c -
```

### Or build it from source

With a Rust toolchain, from the mini-tui checkout:

```bash
cd agent-rs && cargo build --release        # target/release/mini-agent-rs, found automatically
cargo build --release --target x86_64-unknown-linux-musl   # a static binary to copy to other boxes
```

## Which one runs

When mini-tui finds a Rust binary it uses it, and otherwise it uses Python. It looks, in order, at:

1. `MINITUI_AGENT_BIN`, a path you set;
2. `agent-rs/target/release/mini-agent-rs` in the checkout;
3. `~/.local/lib/mini-tui/mini-agent-rs`;
4. `mini-agent-rs` on your `PATH`.

```bash
mini-tui                          # Rust if a binary is found, else Python
MINITUI_AGENT=python mini-tui     # the Python agent, on purpose
MINITUI_AGENT=rust mini-tui       # Rust, and a warning if no binary is found
```

`mini-tui -p -o stream-json` names the agent it used in its first line (`"runner": "rust"`).

For the web app as a service, set the same variables in the unit:

```ini
[Service]
Environment=MINITUI_AGENT_BIN=/home/you/.local/lib/mini-tui/mini-agent-rs
```

## What the Rust agent covers

Everything mini-tui uses:

- **The loop:** step and cost limits, follow-ups, live `/model`, `/compact` and automatic compaction,
  `--resume`, and interrupts.
- **Models:** cli-proxy, Rosetta, DeepSeek, Xiaomi, OpenAI, Anthropic, the provider registry, and
  OpenCode Go.
- **Environments:** local and Docker.

A few things are deliberately not ported, because mini-tui never uses them: the litellm, portkey,
requesty and OpenRouter-SDK model classes, the singularity, bubblewrap, contree and swerex environments,
the interactive confirm mode, and `mini-extra`. Asking for one of them is an error that names what is
supported.

## Subagents: one session, many agents

The Rust agent can split work across **subagents that the session owns**. From its bash tool the
model runs `mini-agent-rs agent spawn <name> "<task>"`; the child is a full agent with its own
context. It keeps that context between turns, so a follow-up is a single message instead of a new
run. You can steer it mid-run with `agent send`. When it finishes, fails, stalls or asks a question,
it reports back to the parent by itself, so the orchestrator never spends steps polling. Children
stop with their session and count toward its cost limit.

Before a fan-out the model reads the room with `agent resources`: the free memory, the **measured
average memory of the running subagents** (each child's whole process group is sampled while it
runs), and `max fan-out now` —

```
min( (MemAvailable - 10 GiB reserve) / avg subagent,  CPU headroom,  100 - live )
```

Up to **100 subagents** can run at once, never past that room: every `spawn` runs the same
calculation at the gate and refuses a child that would not fit, with the numbers, and exits 1). The
session and every other child keep running; only the child that would not fit is not started. The
reserve keeps 10 GiB free for the session itself, so an orchestrated batch can never push the box
into swap or under the OOM killer.

Every subagent is saved as a session under its parent. In the web app a strip above the
transcript lists them with their state, cost and **resident memory**: click one to follow it live
in the pane, or message it like any session. In the terminal UI, `/subagents` lists them and
`/resume` opens one. Reference the bundled `$subagents` skill in a prompt to have the agent use
them.

## The shared context: explored once, handed over

A subagent that re-reads what the orchestrator already read is the biggest cost in a fan-out. On a
measured orchestration (6 subagents, 2 repos) **122,039 of 184,342 tokens — 66% — went on
discovery**, 28 files were re-read that the parent had already read, and 3 integration failures
were left for the parent to find later by reading diffs.

`agent-rs` now keeps that knowledge in one place: the run tree's `context/` folder, as markdown
with a schema. The orchestrator fills it once, before delegating:

```sh
mini-agent-rs agent state put findings.md  --prompt-file f.md   # symbols, files, lines
mini-agent-rs agent state put contracts.md --prompt-file c.md   # the contract, producers/consumers
mini-agent-rs agent state put decisions.md --prompt-file d.md   # what was decided, and why
mini-agent-rs agent state put surface.backend.md --prompt-file s.md   # callers, types, payloads
```

**Every subagent then gets those documents handed over by default** — the parent does not have to
remember to pass them — and **scoped to the repos it works in**: a backend child reads
`surface.backend.md` and the `## backend` sections, and is never billed for the frontend's. The
system prompt tells the orchestrator to fill the store; `MINI_AGENT_CONTEXT=0` turns the handover
off.

Three commands make it work end to end:

- **`agent surface <symbol>`** answers "who calls this, which type carries it, what contract does
  it obey" in one call, from what is already indexed, instead of grepping the tree again.
- **The handshake goes back.** When a child's turn ends, its final answer is parsed into
  `## surface`, `## contract` and `## surprise` and stored as `<child>.md` for the next child.
  `surprise` is the point: it is the one place a subagent can say *the brief is wrong* without
  stopping. In a live run that is how a subagent reported that the backend emitted
  `group_menu_enabled` while the frontend expected `groupMenuEnabled` with no mapping layer — a
  real integration bug, raised by the child that found it instead of merged.
- **`agent contract-check`** runs by itself when a child's turn ends, with no model in the loop:
  every file the child claims to touch exists and is under the repo, every field the contract
  assigns to that repo appears where it should, and a `no <invariant>` clause is checked
  literally. A claim that does not hold fails instead of reaching the parent as a summary.

Measured in the web app against the same task without the store (orchestrator + 2 children over
2 repos):

| | without | with |
| --- | --- | --- |
| child discovery tokens | ~3,197 | ~1,456 (**-54%**) |
| orchestrator tokens | ~26,699 | ~12,093 (**-55%**) |
| integration bugs caught by a subagent | 0 | 1 |

Duplicate file reads do not go down, and should not: a child still reads the file it has to edit.
What the store removes is the orientation work around it.

## One task, many executors: `shard` and `orchestrate`

`mini-agent-rs shard` and `mini-agent-rs orchestrate` split one coding task by file. A hub in plain
code (no planner model) picks the files the task names. It starts one executor per file, all in
parallel, hedges the slow calls, and runs your gate (`--verify`). If the gate fails, fix waves repair
only the files it blames. `orchestrate` is the hybrid: each executor is a copy of one parent session
(repo + task, a shared and cached prefix) with an order for its own file.

On a 20-task suite (2 to 48 files per task), every task passed the gate with every required change in
place, and runs were 2x to 18x faster than a single agent. Not every repeat kept all 20 tasks at 2x or
more. Box by box, with the code behind each one:
**[the orchestration diagram](/diagrams/mini-agent-rs-orchestrate/)**.

## How it is kept identical

`agent-rs/tests/parity/run_all.sh` runs both agents on the same scripted tasks against the same scripted
HTTP servers: 28 scenarios plus 8 helper cases. For each one it checks that both agents:

- write identical trajectories and journals;
- exit the same way;
- send byte-identical requests to the model.

```bash
cd agent-rs && cargo test --release && sh tests/parity/run_all.sh   # ends with "ALL IDENTICAL"
```
