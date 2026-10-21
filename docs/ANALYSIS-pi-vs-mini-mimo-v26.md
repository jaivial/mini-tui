# pi vs mini-tui vs mini-tui-web — comparison, MiMo V2.6 Flash benchmark, and how mini wins

Date: 2026-10-20. Model under test: **Xiaomi MiMo V2.6 Flash** (`mimo-v2.6-flash`, same
endpoint `token-plan-sgp.xiaomimimo.com/v1` for every arm — the model is a constant, only the
harness changes). Corpus: the 10-task harness benchmark in `~/mini-tui-benchmark/tasks`, each
task with a deterministic `verify.sh`. All processes ran inside safe cgroup v2 scopes
(`~/safe-cgroup/safe-run.sh`: memory.max/high/swap caps, pids cap, CPU affinity + nice; a 500 MB
hog was proven to die inside its scope without touching the host).

> Results tables below are filled from `runs/20261020-170656` (mini-orch), the mini-direct pass
> and the pi pass. See section 4.

---

## 1. The three things being compared

They are not three products — they are **one agent core with three surfaces**, plus one
independent harness:

| | **pi** | **mini-tui** (terminal) | **mini-tui-web** |
|---|---|---|---|
| What it is | Standalone coding-agent harness (Node/TS, `@earendil-works/pi-coding-agent`) | TUI over mini's own agent core (`mini-agent-rs`, Rust port of mini-swe-agent) | Web server (`bun src/web/serve.ts`) + Svelte app over the same core |
| Agent loop | 1 model call/turn, tools run **in parallel** (`Promise.all`) by default | 1 model call/turn, action batches executed (overlapped since PR #109) | Same core as mini-tui, spawned per session (`MINITUI_AGENT_BIN`) |
| Tools | 6 small tools: `read`, `bash`, `edit` (oldText/newText), `write`, `codemode` (JS sandbox), plus MCP/extension tools | `bash` + `read`/`write`/`edit`/`code` (Rhai) + `cu`, gated by `MINITUI_AGENT_TOOLS` | Same, plus `agent_delegate`, `agent_define`, kanban/task commands in orchestrator mode |
| Execution model | **Single agent executes directly** | Executes directly (TUI session) | **Orchestrator by default**: top-level prompt says "DELEGATE, not execute"; an "Orchestrator boundary" guard refuses direct edits; work goes to spawned subagents (per-task worker, `MINI_AGENT_DEPTH` escalation) |
| Subagents | Not built in ("skips features like sub-agents and plan mode"; packages can add) | Yes (`/subagents`, `mini-agent-rs agent spawn`, up to `MINI_AGENT_MAX_DEPTH` levels) | Yes — this is the *product* behavior; kanban cards + worker spawn + resource gate |
| Session/UX | TUI, `-p` print/JSON headless, RPC, TS SDK | Prompt bar, command palette, `$skill`, `/model`, `/compact`, `/resume` (SQLite), 6 themes, tool cards | Multi-pane tmux-like windows, sidebar history/folders, subagent strip, notes panes, toasts, remote hosts/SSH, landing page + docs |
| Context mgmt | Compaction, projection per request, cache warmer (`cache-warmer.ts`) | Compaction with calibrated `tokens_per_char`, no cache warmer (99 % cache hit measured) | Same core + session persistence, task graph / RAG / goal oracle extras |
| Ecosystem | **Extensions, skills, prompt templates, themes, pi packages** (npm/git), MCP, model catalog (`/login`, many providers) | Skills folder (imports Claude Code skills), BYOK provider registry (MiniMax catalog incl. Xiaomi MiMo, Z.AI, DeepSeek, OpenCode Go, TokenHarbor, Kimi), `mini-extra` config | Same + channels/consumer bots, orchestration graph, queue/taskgraph, e2e skills |
| Failure handling | Retry with `Retry-After` honored, `min(0.5·2^i, 8)` s backoff | Patient retry (up to 10×, jitter); older policy waited flat 4 s (fixed in items 1-6) | Same core; plus goal-oracle loop that re-opens a task ("Goal oracle rejected closure") |

Key architectural fact for everything below: **mini-tui and mini-tui-web are the same
`mini-agent-rs` core.** They differ in who drives it (human in a terminal vs web session) and in
the role the prompt assigns (executor vs orchestrator). pi is a genuinely separate harness with
a different tool philosophy (few, small, parallel, precise edits) and no delegation machinery.

---

## 2. Method of this benchmark

- **Arms (3):**
  1. `mini-orch` — mini-tui-web as deployed: orchestrator delegates to a subagent worker
     (`bench-mini-orch.service`, port 4391).
  2. `mini-direct` — identical stack with `MINI_AGENT_DEPTH=1`, so the agent executes directly
     (`bench-mini-direct.service`, port 4392). This equals what mini-tui's agent does in a
     terminal session and what rounds 1-6 of `docs/pi-vs-mini-benchmark.md` measured.
  3. `pi` — `pi --provider xiaomi-token-plan-sgp --model mimo-v2.6-flash -p --mode json`.
- **Corpus:** 10 tasks (`t1_wordfreq` … `t10_crash_report`), each in a fresh copy per run, each
  with an objective `verify.sh` (validated 10/10 PASS on hand-written references, 10/10 FAIL on
  pristine state).
- **Measurement:** wall clock per task from session start to `status=done` (mini) / process exit
  (pi); `verify.sh` PASS/FAIL; API calls / turns from trajectories; per-phase timings from
  `traj.json` `extra.timings` (note §9.2 of the old report: `overhead_ms` alone is not a valid
  "harness is free" field — model time must come from `sum_model_ms`).
- **Isolation:** each service and the runner live in their own cgroup (12G/9G-high/2G-swap,
  512 pids, CPUs 0-9, nice 10; runner 8G/6G-high, CPUs 0-7, nice 10).
- **Conditions/caveats:** one repetition per arm; the machine carried unrelated load
  (`ng build`, mythagent, dotnet, mysql — load avg 6-13 on 12 cores) that is **outside** the
  bench cgroups and identical for every arm; run order was orch → direct → pi. Ratios are
  informative, absolute medians less so. Prior rounds (§9 of `docs/pi-vs-mini-benchmark.md`)
  showed per-task wall time variance of up to 8x across reps with a constant-quality model, so
  per-task winners here are noise-prone; totals + pass rates are the signal.

---

## 3. What prior rounds established (context for reading this run)

- Rounds 1-6 (model `minimax/MiniMax-M3`, mini-direct vs pi): quality **40/40 PASS both sides**;
  wall time a **tie** (median 0.98x over 4 full reps); 78-81 % of wall is model time; harness
  overhead ~1 %.
- The mini losses that were real and were fixed (items 1-6, PRs #109/#111): no native
  `write`/`edit`, bash-only writes via heredocs, over-long instance prompt, serial action
  execution, retry backoff shape, O(n²) journal serialization.
- Round 5 lever that stuck: per-turn output cap 4096 (kills pathological reasoning turns).
- What remained open (§9.4): bigger corpus / more reps; variance concentrated in `t10`, `t8`.

**What changed since those rounds: mini-tui-web now delegates.** The orchestrator mode
(`mini.yaml` instance_template: "This is a task for you to DELEGATE, not execute") plus the goal
oracle is new product behavior and is exactly what this run measures on top of the old ties.

---

## 4. Results — MiMo V2.6 Flash

Runs: `runs/20261020-172656` (mini-orch), `runs/20261020-184238` (mini-direct),
`runs/20261020-191330` (pi). 30 runs, **30/30 verify.sh PASS** — quality is a three-way tie on
this corpus; the difference is entirely speed.

| task | mini-orch (s) | mini-direct (s) | pi (s) | orch/pi | direct/pi | all pass |
|---|---|---|---|---|---|---|
| t10_crash_report | 708.5 | 38.0 | 38.4 | 18.5x | 0.99x | ✓ |
| t1_wordfreq | 500.6 | 38.0 | 29.4 | 17.0x | 1.29x | ✓ |
| t2_grep_logs | 144.1 | 62.1 | 19.0 | 7.6x | 3.27x | ✓ |
| t3_pytest_fix | 414.3 | 50.0 | 44.3 | 9.4x | 1.13x | ✓ |
| t4_refactor | 320.2 | 204.1 | 68.7 | 4.7x | 2.97x | ✓ |
| t5_script_csv | 264.2 | 114.1 | 23.8 | 11.1x | 4.79x | ✓ |
| t6_readme_summary | 364.3 | 66.0 | 71.1 | 5.1x | 0.93x | ✓ |
| t7_regex_cli | 1379.2 | 1192.8 | 30.8 | 44.8x | 38.7x | ✓ |
| t8_js_bug | 216.2 | 46.0 | 72.7 | 3.0x | 0.63x | ✓ |
| t9_pkg_resize | 224.2 | 36.0 | 28.6 | 7.8x | 1.26x | ✓ |
| **total** | **4535.8** | **1847.1** | **426.8** | **10.6x** | **4.3x** | **30/30** |
| median | 342.2 | 56.0 | 34.6 | 9.9x | 1.6x | |
| model calls | 146 | 107 | 56 | 2.6x | 1.9x | |
| model time | 1260 s | 1072 s | 417 s | 3.0x | 2.6x | |
| non-model gap | 3276 s (72 %) | 775 s (42 %) | ~10 s (2 %) | | | |

Where the wall time goes per task (mini arms: `wall / model_time / gap`):

- `t7_regex_cli` is the outlier of the whole benchmark: **6 goal-oracle reopens**, 31 steps,
  38 API calls, 74 trajectory messages, 562 s of non-model gap in direct mode. pi solved the
  same task in 30.8 s with no reopens.
- `t10_crash_report` orch 708.5 s vs direct 38.0 s (18.6x): pure delegation + oracle tax.
- mini's per-step model time is 12.5 s vs pi's 7.4 s per turn, and it takes 8.6 steps/task vs
  pi's 5.6 — mini loses on both multiplicands.

Verdict on the question asked — "is mini better than pi?": **not on this corpus.** Quality ties
at 10/10; pi is **4.3x faster** than the fastest mini configuration (direct) and **10.6x faster**
than mini-tui-web as deployed (orchestrator). mini-direct does beat pi on 3 of 10 tasks
(`t6`, `t8`, `t10` ≈ tie) but loses the rest, catastrophically on `t7`.

---

## 5. Analysis

**Why pi is faster (same model, same tasks):**

1. **Fewer turns** — pi 56 turns vs mini-direct 86 steps vs mini-orch 124 steps. pi's prompt
   demands no reproduction scripts, no handshake lines, no card bookkeeping; mini's
   `instance_template` mandates a verification workflow that manufactures extra steps
   (`t7`: 31 steps for a 30-line CLI).
2. **Cheaper turns** — 7.4 s of model time per pi turn vs 12.5 s per mini step. pi's context per
   call is leaner (6 small tools, no kanban/delegation surface, no shared-context block) and its
   turns are shorter.
3. **No inter-turn machinery** — pi's wall ≈ model time (98 %): stream → tools → stream. mini
   pays oracle scoring calls, closure checks, session/kanban bookkeeping and 2 s status polling
   *between* turns, invisibly to `extra.timings`.
4. **No delegation tax** — a single agent executes; mini-orch routes every task through a
   coordinator + worker + handoff (2x calls on trivial tasks).

**What mini does not lose on:** quality (30/30 PASS), tool execution speed (harness time is
6.2 s / 34.3 s total), retry patience, and it wins 3/10 individual tasks even in direct mode.

### Where the time actually goes (this run's measurement)

| source | mini-orch | mini-direct | pi |
|---|---|---|---|
| model calls' own time | 28 % | 58 % | 98 % |
| goal-oracle rounds, spawn/kanban/polling gaps | 72 % | 42 % | ~2 % |

The old finding "harness overhead is ~1 % of wall" (rounds 1-6) is **invalidated for the current
stack**: it was measured before the goal oracle and delegation existed, and neither appears in
`extra.timings`. Even `mini-direct` — no delegation at all — loses 42 % of wall outside the
agent's own model calls.

### Findings

1. **The goal oracle deletes the harness's verifier (pass-rate killer).** In the first
   (aborted) run, the worker of `t1_wordfreq` produced a *correct* `answer.json`, then the
   goal oracle rejected closure (45/100) and issued its own gap-closure list whose step 5 read
   "verify.sh was a scratch checker beyond the requested deliverable — … delete it". The agent
   obeyed ("verify.sh deleted"), and the scorer recorded FAIL on correct work. The oracle
   hallucinated the provenance of a file that existed before the run; nothing in the system
   tracks the workspace's initial state, so "cleanup" may delete anything. pi has no oracle loop
   and never touches the verifier. The runner now restores the verifier from the pristine task
   copy before scoring and records `verifier_tampered` per row; the score is the work's, and the
   tampering is counted as evidence.
2. **The goal-oracle loop costs whole minutes per task (speed killer).** Closures are rejected
   subjectively ("rejected closure at 5x/100", "your evidence was prose claims") and each
   rejection re-opens the worker for an evidence round: observed 0–2 reopens per task so far,
   24 → 50 messages in a worker's trajectory, and `t10_crash_report` moving from 262 s
   (first run,1 reopen) to 708 s (second run, 2 reopens) at identical quality. Every reopen is
   pure harness-induced model time — the one large *harness* lever left, contradicting the old
   "harness is ~1 %" finding, which predates the oracle/delegation stack.
3. **Delegation itself is a fixed tax.** A trivial task ("create hello.txt") costs 8 API calls
   through the orchestrator vs 4 direct (smoke test, 2026-10-20): kanban card creation,
   spawn, handoff, completion handling. On small tasks that is 2x the calls before any real
   work happens.
4. **The subagent resource guard must be cgroup-aware-safe.** `resources.rs` reserves 10 GiB
   by default and reads cgroup-available memory; inside a tight cgroup (4 GB) it refused every
   worker spawn and the orchestrator looped (17 calls, task not done). The guard is right in
   spirit (protect the box) but its default reserve makes mini un-bootable in containers with
   small memory limits — a very common deployment. Knobs exist
   (`MINI_AGENT_RESERVE_MEM_MB`, `MINI_AGENT_CHILD_MEM_MB`) but must be set correctly per
   deployment, and a session that cannot spawn should fall back to executing directly instead
   of looping on refused spawns.

---

## 6. How mini beats pi on both axes (speed and % completed)

Ordered by measured return from this run.

### Speed (wall time)

| # | Lever | Evidence from this run | Expected effect |
|---|---|---|---|
| 1 | **Cap the goal-oracle loop**: at most 1 reopen per session; the oracle *scores* closure but may not issue imperative instructions (no "delete/clean up/rewrite"); require it to cite observed tool output for every gap | `t7_regex_cli`: 6 reopens → 1193 s direct vs pi 31 s; `t10`: 2 reopens → 709 s vs 38 s | mini-direct total ≈ 1847 → ~900–1100 s (≈2.2–2.7x faster) |
| 2 | **Direct execution by default; delegate only big work** (size heuristic or model's first-turn choice). Keep orchestrator for genuinely parallel work | mini-orch 4536 s vs mini-direct 1847 s on the same tasks = **2.5x delegation tax** | mini-tui-web ≈ mini-direct on single-file tasks |
| 3 | **Short-task prompt mode**: drop the mandatory verification workflow / handshake / reproduction-script requirements when the task is small; ask for ONE evidence run | mini 8.6 steps/task vs pi 5.6; `t7` 31 steps for a small CLI | −20–30 % steps → −20–30 % model time |
| 4 | **Lean the per-call context** (kanban/shared-context/verification boilerplate) and hold the per-turn output cap at 4096; compare thinking levels fairly (pi ran `medium`) | 12.5 s model/step (mini) vs 7.4 s (pi) | −15–25 % model time |
| 5 | **Turn-gap hygiene**: faster session spawn, tighter status streaming than 2 s polling, oracle calls counted and minimized | 42 % of mini-direct wall is non-model gap vs 2 % for pi | −10–20 % wall |

Do **not** chase harness micro-overhead (6.2–34.3 s total across 10 tasks): it is not where the
4.3x lives.

### % of tasks completed

| # | Lever | Evidence | Why it moves pass rate |
|---|---|---|---|
| 1 | **Initial-state manifest; never delete/modify pre-existing files.** The cleanup policy may only target files the session created | oracle told the worker to delete `verify.sh` (pre-existing verifier) → correct work scored FAIL in the aborted run | Removes a whole class of self-inflicted failures in any benchmark whose verifier lives in the workspace (Terminal-Bench-style task dirs, CI repos) |
| 2 | **Fallback when delegation is impossible**: if `max_fanout == 0` (memory guard, container caps), execute directly instead of looping on refused spawns | smoke test in a 4 GB cgroup: 17 calls, nothing done, task failed | In capped environments (most real deployments) the current behavior is a guaranteed 0 % |
| 3 | **Oracle claims must cite evidence**; oracle outputs are scores, not commands | "verify.sh was a scratch checker" was a hallucination that became a destructive action | Fewer wrong reopens → fewer wasted turns before a task hits its step/time limit |
| 4 | **Fewer, more decisive steps on hard tasks** (same as speed #3/#4): step-limit exits turn "slow" into "failed" on harder corpora (rounds 1-6: median 200 = the limit) | `t7`: 31 steps + 6 reopens | Direct pass-rate effect on Terminal-Bench/DeepSWE-class tasks |
| 5 | **Prove pass rate where it discriminates**: this corpus is too easy (everyone 10/10). Run FrontierHarness Eval (Terminal-Bench 21 + DeepSWE 9), where the published pi baseline is 60 %, with `mini-tui/benchmark/frontier-harness/run-baseline.sh mini|pi` and `FH_MODEL=…/mimo-v2.6-flash` | prior partial run: mini 4/4 universal tasks, 6.5 calls per proven pass vs Codex's 62 turns | The only place where "% completed" can be won or lost measurably |

### Bottom line

With the same MiMo V2.6 Flash model, **pi is 4.3x faster than mini's best configuration and
10.6x faster than mini-tui-web as deployed**, at equal quality. mini can plausibly get to parity
by fixing the oracle loop + delegation default (levers 1-2: together worth ~4–5x on this
micro-corpus) and to a *win* on tasks where its parallel workers genuinely overlap — the one
architecture pi does not have at all.
