# `mini-agent-rs repl` — an RLM-style REPL harness in Rust

Status: **prototype** (behind its own subcommand; nothing else in the binary depends on it).

## Why

A normal agent reads data by `cat`-ing it into its own context window. Past the window size it
either truncates, compacts (lossy) or fails. The Recursive Language Model idea (Zhang et al.;
used as the core of Prime Agent, arXiv:2608.23552) inverts that: the data is a **variable in a
REPL**, and the model writes code that inspects it, printing only what it decides to look at.
Sub-questions become **function calls** (`llm(...)`, `rlm(...)`) that run in fresh contexts.

## What it is

```
mini-agent-rs repl -t TASK --context PATH [--root DIR] [--sh --lane PATH] [--state F] [-o traj.json]
```

| Piece | Implementation |
|---|---|
| Interpreter | [Rhai](https://rhai.rs) embedded (pure Rust; no Python/Node). Scope persists across cells. |
| Context outside the prompt | `context` = the file (string) or folder (map path→text). The model sees only a one-line description: size, line count, first 200 chars. |
| Cells | A ```rhai fenced block, or the `command` of the bash tool call (models trained on a bash tool keep using it; here it is the REPL). Output truncated to 4,000 chars per cell (`MINI_REPL_OUT_MAX`). |
| Sub-calls | `llm(p)` (one plain call), `llm_batch([..])` (parallel threads, `MINI_REPL_PAR`=8), `rlm(p, ctx)` / `rlm_batch` (a whole recursive session with its own REPL; depth capped, `--max-depth` 2). |
| Answer | `FINAL(x)` — ignored if the same cell also printed (the model has not seen that output yet). |
| Sandbox | Rhai has no fs/net/process API. Module resolver = dummy, `eval` disabled, caps on operations (2e8), string (64 MiB), array/map (1M), call depth (64), wall-clock per cell (600 s). Only doors: the functions above; `read`/`ls` (opt-in `--root`, canonicalized, refuses escapes); `sh` (opt-in `--sh`: bubblewrap, read-only `/`, private `/tmp`, `--unshare-net`, only `--lane` paths writable). |
| Persistence | `--state F`: plain values (strings, numbers, arrays, maps) saved as JSON at exit, loaded at start. |
| Accounting | Root vs sub calls, prompt chars actually sent, tokens when the provider reports them, cells, cell errors, interpreter seconds, max depth reached. |

## How it plugs into mini-tui

1. **As a tool of a normal session** (smallest step): the agent runs
   `mini-agent-rs repl -t "..." --context big.log` from its bash tool and reads the one-line
   answer. The 2 MB never enters the session's window. Works today.
2. **As a dispatch task kind**: `{"id": "...", "kind": "repl", "context": "logs/", "task": "..."}`
   in a `plan.json` — the hub launches `repl` instead of a full agent. Its `files`/`lane` become
   `--lane` for `sh`, so the same lane enforcement applies.
3. **As the ContextStore reader**: `--context <run>/context/` hands the shared store (findings,
   contracts, surface.<repo>) to the REPL as a map, instead of pasting it into each child's
   prompt (today: up to 32 KiB per child, paid by every child, every step).
4. **TUI/web**: the `-o` trajectory uses the same shape mini-tui already renders.

## What it is not (yet)

- Not the existing `rlm` subcommand (a line DSL where `call` is a sub-agent with a bash tool).
  `repl` is the RLM-paper shape: code over a context variable, LM calls as functions.
- Sub-calls are synchronous inside a cell (`llm_batch`/`rlm_batch` parallelize *within* a cell);
  Prime Agent's `rlm` returns a handle and the child runs as a persistent, messageable session.
- No Continual Harness (skills/memories/refinement), no daemon, no agent-to-agent messaging.
