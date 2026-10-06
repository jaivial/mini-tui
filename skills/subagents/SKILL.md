---
name: subagents
description: >
  Split work across subagents that this session starts and owns (Rust agent, `mini-agent-rs agent`).
  Each subagent is a full agent with its own context; it keeps that context between turns, takes
  messages mid-run, reports back when it finishes, and shows up as a session under this one in the
  web app and the TUI. Use when a task splits into independent parts, when the user asks to fan out,
  delegate, orchestrate or run agents in parallel, or says $subagents or $orchestration.
metadata:
  short-description: "Spawn, steer and collect subagents owned by this session"
---

# Subagents of this session

Run these from your bash tool. They talk to the agent running this session (through
`MINI_AGENT_SOCKET`), which starts and owns the children: they stop when this session stops, their
spend counts toward its cost limit, and every one is saved as a session under this one.

```bash
mini-agent-rs agent spawn <name> [--cwd DIR] [-m MODEL] [--max-steps N] [--cost-limit USD] [--skill NAME] "<task>"
mini-agent-rs agent spawn <name> --prompt-file task.md      # long tasks ('-' = stdin)
mini-agent-rs agent spawn <name> --context-file notes.md ... # hand over what you know (repeatable)
mini-agent-rs agent spawn <name> --brief --prompt-file brief.md   # a structured brief
mini-agent-rs agent resources [--json]     # free memory, avg subagent cost, max fan-out
mini-agent-rs agent can-spawn N            # would N more fit right now?
mini-agent-rs agent ls                     # NAME STATE STEPS COST IDLE LAST
mini-agent-rs agent send <name> "<text>"   # steer it mid-run, or continue a finished one
mini-agent-rs agent wait [names] [--any] [--timeout 20]
mini-agent-rs agent result <name>          # its final answer
mini-agent-rs agent tail <name> -n 10      # its last steps
mini-agent-rs agent model <name> <model>   # escalate a hard task to a stronger model
mini-agent-rs agent stop <name>|--all      # interrupt (it saves); `send` continues it later
```

`spawn` returns at once. States: `starting`, `running`, `waiting` (its turn ended; it holds its
whole context for `send`), `stopped`, `exited`. Exit codes: 0 ok, 1 refused (the reason is printed),
2 usage, 3 `wait` timed out.

## How the loop works

1. **Plan the split.** One self-contained task per subagent: the folder (`--cwd`), the files, what
   "done" means, and that it must end with a short summary. Subagents share nothing but the
   filesystem: never give two of them the same files. For parallel edits in one repo, give each its
   own `git worktree`. **Hand over what you already know** (see "Hand context over" below): a child
   that re-discovers your searches pays for them again.
2. **Spawn** them one after another (each call returns in a moment). Name them by job (`api-tests`,
   `fix-auth`). Reference the skills they must follow with `$name` in their task (or `--skill`):
   the skill is inlined for them, once.
3. **Keep working or end your turn.** You do not need to poll. When a subagent finishes, fails,
   stalls (10 min without output) or asks you something, a message starting with
   `[subagent <name>]` reaches you before your next step; if you had already finished your turn,
   that message wakes you up. `agent wait` is there when you want to block for a moment (it waits at
   most `--timeout` seconds, 20 by default: the bash tool itself times out at 30).
4. **Steer.** `agent send <name> "…"` reaches a running subagent before its next model call: use it
   to correct course instead of stopping it. A subagent that hit `LimitsExceeded` gets a fresh budget
   with your next `send` and continues with its context.
5. **Review every result before you accept it.** A subagent's summary is a claim, not proof.
   Read `agent result <name>`, then check the work yourself: the diff of its files
   (`git diff --stat`, then the diff itself), the build and tests it was told to pass, and every
   point of its task, one by one. Done means you verified it, not that it said so.
6. **Send improvements to the same subagent.** When the review finds something missing, wrong,
   unverified or below the bar of the task, do not fix it yourself and do not spawn a new
   subagent: `agent send <name> "<review>"` goes into that subagent's own session, which still has
   all its context. Write the review as a prompt it can act on alone:
   - each finding with its file and line, what is wrong, and what done looks like;
   - the exact check it must run and pass afterwards (build, test, command);
   - "end with a short summary of what you changed".
   Then wait for its next result and review again. Repeat until the review finds nothing to
   improve. If a subagent is stuck after 3 rounds on the same finding, escalate it
   (`agent model <name> <stronger-model>`) and send the review again; only then take over the
   finding yourself and say so in the report.
7. **Report** a short table to the user: subagent, state, steps, cost, review rounds, one-line
   result (verified by you). They can open any subagent in the web app (the strip above the
   transcript) or with `/resume` in the TUI.

## Hand context over, do not make it re-discover

A child starts cold: it knows only its task. Everything you already found out costs it steps and
tokens again unless you hand it over. Three layers, cheapest first:

1. **`--brief` (a structured brief in the task).** Write the task as sections — `## Goal`,
   `## Key paths`, `## Conventions`, `## Searches done`, `## Decisions` (Spanish headings work too:
   objetivo / rutas clave / convenciones / búsquedas / decisiones). `--brief` validates the shape
   (goal plus 3 sections minimum) and wraps it in `<brief>` so the child knows it is your summary,
   not ground truth. Put the detail in `--context-file`, keep the brief short.
2. **`--context-file F` (what you read, handed over verbatim).** Notes, spec excerpts, the map of
   the code you already made: each file arrives as a `<context>` block before the task (capped at
   32 KiB together, `MINI_AGENT_CONTEXT_MAX`), so the child reads instead of re-searching.
3. **The shared state on disk (`<run dir>/context/`).** Every session of the run tree gets a
   `<shared-context>` note pointing at one append-only folder. Convention: one file per task
   (`context/<task-id>.md`, stamped with date and author) for findings and artifacts;
   `context/findings.md` and `context/search-cache.jsonl` are shared scratch. A child checks what
   prior tasks left there before searching, and leaves what it learned for the next one.

A refused brief or an oversized context file is an error before the child starts: fix the brief or
trim the file, the spawn does not silently drop your context.

## Inside a subagent

You were started by another session for one task. Do it and end with a short summary. A
message from that session with a review is a request to improve your work: fix every finding in
it, run the checks it names, and end with a new summary. If you are blocked on a decision only that session can make, `mini-agent-rs agent ask "<question>"` sends it
there; keep working on what you can meanwhile, its answer arrives as a new message.

## Before you fan out: check the box

Every `spawn` is refused when the machine cannot afford it, so find out first:

```bash
mini-agent-rs agent resources
# free memory 45.8 GiB of 62.7 GiB - reserve 10.0 GiB - available to spend 35.8 GiB
# avg subagent 256 MiB (floor 256 MiB) - 0 live of a cap of 100
# cpus 12 - load 11.43
# max fan-out now: 100 more subagents
```

The number to plan around is **`max fan-out now`**: how many more may start, and it is

```
min( (MemAvailable - reserve) / per-subagent,  CPU headroom,  100 - live )
```

- `reserve` is **10 GiB** by default (`MINI_AGENT_RESERVE_MEM_MB`): memory this session never spends
  on subagents, so the box never gets pushed into swap or killed by the OOM killer.
- `per subagent` is the **average RSS of the running subagents, measured** (rolling mean of samples
  of each child's whole process group); until one has been measured it is a 256 MiB floor
  (`MINI_AGENT_CHILD_MEM_MB`). Children you fan out have a cost, not a hope: heavy ones are charged
  their real average, so fewer of them fit.
- The CPU term binds only when the box is already saturated (1-min load >= the CPU count); below
  that, subagents are mostly waiting on the model and the CPU is not the limit.
- The last term is the cap: **100 live** subagents, the hard ceiling. `agent can-spawn N` turns
  a plan of N into "all N fit now" or "spawn N as these finish".

So measure and then decide how many to start:

```bash
mini-agent-rs agent resources --json | jq -r '.max_fanout'   # machine-readable
mini-agent-rs agent can-spawn 30                             # "room for 30 more" or why not
```

If `max fan-out now` is 0, do not spawn: `agent resources` says what binds (the reserve, a heavier
average child than free memory, or the CPU). Stop the children that are done (`agent stop w1 w2`),
collect their results, and spawn the rest as the room reappears. **The session survives a refused
spawn** - only that child does not start (exit code 1, the reason printed); no batch is ever taken
down because one more did not fit.

## Limits

- Up to **100 live subagents** per session (`MINI_AGENT_MAX_SUBAGENTS`, clamped to 100), never past
  the free memory the calculus above allows, nesting 2 deep (`MINI_AGENT_MAX_DEPTH`). Each turn
  defaults to 200 steps and $2, capped by what this session's cost limit has left.
- Only the Rust agent (`mini-agent-rs`) has subagents. On the Python agent, `agent` commands say so;
  use `$orchestration` (`orch`) there.
