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
   own `git worktree`.
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
5. **Collect.** Read `agent result <name>`, then check the claims yourself (`git diff --stat`, run
   the tests) before you report. A follow-up is `agent send <name> "now add tests"`: the same
   subagent, with everything it already knows, no new run.
6. **Report** a short table to the user: subagent, state, steps, cost, one-line result. They can
   open any subagent in the web app (the strip above the transcript) or with `/resume` in the TUI.

## Inside a subagent

You were started by another session for one task. Do it and end with a short summary. If you are
blocked on a decision only that session can make, `mini-agent-rs agent ask "<question>"` sends it
there; keep working on what you can meanwhile, its answer arrives as a new message.

## Limits

- At most 8 live subagents per session (`MINI_AGENT_MAX_SUBAGENTS`), nesting 2 deep
  (`MINI_AGENT_MAX_DEPTH`). Each turn defaults to 200 steps and $2, capped by what this session's
  cost limit has left.
- Only the Rust agent (`mini-agent-rs`) has subagents. On the Python agent, `agent` commands say so;
  use `$orchestration` (`orch`) there.
