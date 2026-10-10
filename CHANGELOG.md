# Changelog

All notable changes to mini-tui, newest first. Versions follow [semver](https://semver.org/).

## Unreleased

### Changed

- **The per-turn output budget is now capped at 4096** (it was an unstated 8192), and a turn that
  hits the cap is a retryable format error instead of an answer. Round 5 of the pi benchmark showed
  the front was never the *number* of turns but the length of the worst one: over the round-4
  corpus the longest single turn of a run was a median **30 %** of that run's wall time, and those
  turns are almost entirely reasoning — the worst turn wrote **19 427 chars of `<think>` to emit a
  193-char tool call**, while the longest non-reasoning payload across 73 turns was 1 241 chars.
  Measured over the whole corpus, back to back per task: 4096 is **0.73x** the wall time of 8192 on
  7 of 10 tasks, truncates **zero** turns, and halves both the median longest turn (8.0 s → 3.5 s)
  and the median generated text (2 513 → 1 266 chars). 2048 is not faster enough to pay (0.69x) and
  did truncate a turn; 3072 lost a task outright. Override with `MSWEA_MAX_TOKENS` or
  `model.max_tokens` (an explicit `model_kwargs.max_tokens` still wins).
  - **A truncated turn is never read as the final answer.** It has no `tool_calls` and minimax puts
    its reasoning in `content`, so the `tool_calls.is_empty()` arm was reading that reasoning as the
    run's result and submitting a run that had done nothing — measured, that is how a run lost a
    task it would otherwise have passed. It now falls through to `parse_toolcall_actions`, whose
    "no tool call" branch is already a format error the loop retries, so the model finishes the
    thought it was cut off in and only a turn that emitted a real tool call is spent.
- **The verifier phase now runs in the agent, not only in the terminal UI** (#115 shipped it in
  `src/ui/App.tsx`, so a run started by the web app, by `mini-tui -p` or by a subagent — the surfaces
  the pi benchmark measures — never got a verdict). `agent-rs/src/jev.rs` runs it once the loop has
  ended and the code is on disk: the run's **own** model proposes candidate defects in
  `git diff HEAD` plus the untracked files, and Jev answers the three typed questions per candidate.
  `info.jev_verifier` in `traj.json` carries the structured report (status, reason, model, latency,
  candidates, findings with their probabilities and the branch they took); the transcript gets one
  notice in the same wording the TUI prints. `MINI_AGENT_JEV=1` turns it on, `auto` (default) runs it
  only when the run left a diff, `off` never does. Same thresholds as `src/jev/verifier.ts`, same
  "never block the run" contract, and every missing piece (no diff, no reader, no key, reader
  failure, unparseable output, HTTP error) degrades with a stated reason.
  - The reader is the run's own client (`Model::reader_endpoint`), so a second `/connect` provider
    is not needed. Measured: an unused-import diff came back as one candidate judged by
    `jev-1.13.0` in 274 ms, and Jev scored it P(real)=0.46 / P(serious)=0.03 — correctly *not* a
    defect. It is not a good reader, though: on a hand-written `safe_div` with a bare `except`,
    MiniMax-M3 proposed no candidate at all, and the phase reported `reader proposed no candidates`.
    That is the honest limit of this configuration: the reader is the run's model because asking for
    a second credential was the worse trade.

### Added

- **Jev (TypeSafe System One) as two independent, optional toggles** (#115).
  - **Toggle 1 — `jev`**: the System One decision service and its API key. The key goes into a
    small vault (`~/.config/mini-tui/vault.json`, 0600) as `jev-api-key`, editable in
    `/settings` → jev (masked, never rendered in full) or with `mini-tui settings jev-key <key>`.
    Endpoint is `https://api.typesafe.ai` (`POST /v1/systemone`, `Bearer`), NOT OpenRouter, which
    stays a plain chat provider. Keys resolve vault → `$TYPESAFE_API_KEY` → `~/.config/typesafe/config.json`
    → `brain.json`, in one function every surface shares, so the panel, the CLI and a run can never
    disagree about which key is in force.
  - **Toggle 2 — `jev-verifier`**: an optional post-code phase. After a turn finishes, a cheap LLM
    (the smallest model of an existing `/connect` provider — no second credential) reads the diff
    and proposes candidate defects; Jev answers three typed Noul questions per candidate (is it
    real / is it serious / is it safe to fix unattended) and fixed thresholds in `THRESHOLDS` branch
    the result into `auto-fix` / `flag` / `ignore`. The report lands as a transcript notice; it never
    blocks the prompt or the run, and any missing piece (no diff, no reader, no key, HTTP error)
    degrades with a stated reason instead of an invented verdict.
  - `mini-tui jev check` (and `c` in the panel) probes `GET /v1/models` with the key in force and
    names the concrete model that answers.

  Both toggles ship **off** and neither reads the other's state: Jev can be on with the phase off,
  the phase on with Jev off.

## 0.40.0 — 2026-10-09

The web UI gets its agents panel (live graph, tabs, session persistence), the agent drops its
default budgets, and the Rust agent closes most of the speed gap with the pi harness.

### Added

- **Agents panel in the web UI** (#102, #103, #104, #105, #106, #107). A real-time graph of the
  session's agents (@xyflow/svelte over SSE), tabs for Agents/Graph/Messages/Definitions, session
  tasks per window in the sidebar, sessions that survive a server restart, no more redirect when
  clicking stopped sessions, `x-accel-buffering: no` on the agent stream, and structured debug
  logging across the orchestration path.
- **Shell-free `read` tool in agent-rs** (#111, pi-speed item 4). Reads a file directly - no
  `/bin/sh` spawn - paginated by `offset`/`limit` with a 2000-line / 50KB budget and a
  continuation note; `bash` stays the only mutating path. Gated by `MINITUI_AGENT_TOOLS=1`.
- **Prompt-cache warmer** (#111, pi-speed item 5). Refreshes at `max(1, min(0.9 x TTL, TTL - 10s))`
  when `MSWEA_CACHE_TTL` is set, only when pi's economics say it pays (>= $0.05 expected saving
  from the model's own price row).
- **Per-phase step timings** (#111, pi-speed item 6). PI_TIMING-style timings recorded in `extra`.
- **`skills/villa-release`** skill.

### Changed

- **Unlimited by default** (#108). No more 200-step / $2 subagent / $3 parent caps; spawn-requested
  budgets are ignored and auto-extend is generous.
- **agent-rs speed, items 1-3** (#109). Retry clock, overlapped tool actions, no per-step clone.

### Fixed

- **Stuck subagents on SIGTERM** (#110). Children are stopped and recorded on SIGTERM, and dead
  pids are reported as dead instead of blocking the parent.

## 0.39.0 — 2026-10-07

Claude Haiku 5.5 is in the curated model picker, and `agent dispatch` can end the parent's turn
on the wave itself (`--join`), with each child confined to its lane.

### Added

- **`cliproxy/claude-haiku-5-5`.** The cli-proxy gateway advertises Anthropic's new
  Claude Haiku 5.5, and mini-tui lists it in the `/model` catalog next to
  `cliproxy/claude-opus-5-5` and `cliproxy/claude-sonnet-5-5`. It runs over the same Claude
  subscription credential and gets the 1M-token context window (automatic compaction),
  in both the Python agent and `agent-rs`.
- **`agent dispatch --join`** (#89). The parent's turn ends on the dispatch; when the last
  child finishes the hub runs `--verify` once and answers with every child's result, so the
  parent spends one step after the wave instead of 41–103 s re-checking it.
- **Enforced lanes** (#89). A plan task's `files` (and optional `lane`) are the only paths its
  child can write: the bash tool runs under bubblewrap with the work tree read-only outside
  the lane (unchanged behaviour where `bwrap` is missing).

### Changed

- **Dispatch shard sizing and wave admission** (#89). Shards are sized in lines, the wave warns
  when the heaviest is over 1.5x the lightest and starts it first; a wave is admitted as a
  whole on memory, and its children are no longer re-gated one by one on CPU load.
- **Child task header** (#89) states `## Where` (the work tree) and `## Scope` (the gate is
  the proof; no test-harness side quests).

### Fixed

- **Headless agents wrote task cards into other sessions** (#89). The session-tasks rule told
  every agent to run `mini-tui tasks set`; a headless run could not find its own session and
  overwrote a live one. The rule now renders only when `MSWEA_CONTROL_FILE` is set, and never
  for lane children.

## 0.38.2 — 2026-10-07

### Fixed

Patch release. 0.38.1 fixed five ways `agent contract-check` could report a pass over nothing
(defects 1–5). Probing the fixed checker, an orchestrator found two more in the same arm; those
fixes (PR #84) landed on `main` after the 0.38.1 tag and ship here (defects 6–7).

- **`contract-check` ignored `--prompt-file`, and dropped the positional handshake whenever
  `--repo` was given** (both found by an orchestrator probing the checker, both verified fixed
  in the browser). `--prompt-file` is parsed into `req["text_file"]` while the arm only read
  `req["handshake"]`, so the documented way to check an arbitrary answer silently examined a
  *stored child's* handshake instead — which is how a control naming a file that did not exist
  came back `4/4 pass`. And the positional form `contract-check [repo] [root] [handshake...]`
  read the handshake from index 2 whether or not `--repo` had consumed the repo slot. All
  three invocation forms now examine the text they were handed.

## 0.38.1 — 2026-10-07

### Fixed

- **`agent contract-check` no longer reports a pass over nothing.** Five separate ways to get a
  green check that had examined nothing were found by running real orchestrations in the browser;
  every one of them is a mechanical check parsing free text with a rule free text does not obey.
  - **A vacuous pass**: a child that ended with good prose but no `surface:` tag claimed no files,
    so the corpus was empty, every clause was trivially satisfied and the check printed `3/3 pass`
    — indistinguishable from "the contract holds". There is now a fourth check, `coverage`, which
    fails when no file was claimed *and* no clause names the repo, and says so in the message.
  - **A false missing file**: splitting a prose `surface:` line on commas invented a file called
    `which registerRoutes (backend/routes.go`. A claim has to be a real path, so
    `path_tokens()` takes every path-shaped token and cuts the `:line` before the extension (else
    `handler.go:18` reads as extension `go:18` and is thrown away).
  - **Prose parsed as identifiers**: a contract clause is a sentence, and `There` and `Neither` are
    Capitalised and 5+ characters, so they passed the snake_case/CamelCase filter — the check then
    demanded that the source literally contain the word "There". `is_identifier()` now requires
    what a field name has and a sentence word does not: a `_` with a letter, or an uppercase
    followed by a lowercase *inside* the token (`groupMenuEnabled`), or a dotted code path, minus a
    stoplist of the words that start a clause. A clause naming no field is skipped, not failed.
  - **`--repo` was ignored**: `--repo` is parsed into `repos` by the shared flag parser while the
    `contract-check` arm read `repo` from the positional, so the documented
    `agent contract-check --repo backend` asked about the repo named `""` and printed `4/4 pass`
    over zero clauses. `repos` now wins when the flag is present; the positional remains the
    fallback for `contract-check <repo> [root]`.
  - **The wrong repo**: the hub took the last segment of a child's `--cwd` as its repo, so a child
    in `backend/.worktrees/be-x` was checked against a repo called `be-x` — one nothing mentions,
    so again nothing was checked. `Child` now carries the repos `repos_of()` resolved at spawn, and
    a child handed two slices is checked against both repos' clauses.

### Measured

Same 6-file two-repo task, orchestrator exploring **once**, in the web UI:

| | before | after |
|---|---|---|
| discovery tokens per subagent | ~1,962 | **~0** |
| subagent steps | 40 | **28** |

Fewer steps for more work: the children stopped re-discovering the code their parent had already
read. The saving is paid for up front by the orchestrator, so it amortises with more children or a
bigger repo — on a 6-file repo the orchestrator's own exploration still costs about as much as a
child's would have.

The fifth defect was found by an *orchestrator*, not by a human: it received `4/4 pass`, copied the
tree to `/tmp`, deleted the wire field, re-ran the check, got `4/4 pass` again with the field gone,
and reported its own integration check as toothless. Nothing prompted it to do that.

## 0.38.0 — 2026-10-07

### Added

- **The shared context (`ContextStore`) — the exploration is paid for once (F7 of the execution
  order — Fase 7 of [`docs/orchestration-plan.md`](docs/orchestration-plan.md))**: a real
  orchestration measured on 2026-10-07 (6 subagents over 2 repos) spent **122,039 of 184,342
  tokens (66%) re-discovering what the orchestrator already knew**, re-read 28 files, and left 3
  integration failures to be found later by the parent reading diffs. `agent-rs` now carries that
  knowledge in one place: `agent state put <key>` writes markdown documents into the run tree's
  `context/` (`findings`, `contracts`, `decisions`, `surface.<repo>`), and **every child gets
  them handed over by default** (`MINI_AGENT_CONTEXT=0` opts out), scoped to the repos it works
  in — a backend child reads `surface.backend.md` and the `## backend` sections, and is never
  billed for the frontend's. No cooperation from the parent required: repos come from the new
  `--repo` flag or, failing that, from the child's own `--cwd`.
- **`agent surface <symbol>`**: who calls it, which type carries it and what contract it obeys,
  answered in one call from the indexed documents instead of grepping the tree again; `agent
  surface ls` lists what is indexed.
- **The handshake back to the orchestrator**: when a child's turn ends the hub parses its final
  answer into `## surface`, `## contract` and `## surprise` and stores it as `<child>.md` for
  the next child to read. `surprise` is what makes this work — it is the one place a subagent can
  report that the brief is wrong without stopping, so an integration mismatch is raised by the
  child that found it instead of being rediscovered later. In a live run this is how a subagent
  reported that the backend emitted `group_menu_enabled` while the frontend expected
  `groupMenuEnabled` with no mapping layer: the field would have been `false` forever.
- **`agent contract-check --repo R`**, run automatically when a child's turn ends: every file it
  claims to touch exists and is under the repo, every field the contract assigns to that repo
  appears where it should, and a `no <invariant>` clause is checked literally. No model in the
  loop, so a claim that does not hold fails instead of reaching the parent as a summary.
- **The RLM harness seeds the same store**: `rlm.rs` points it at its context directory on
  startup and exposes the documents as `{{context.<key>}}` variables, so a scripted
  orchestration sees what a chat one sees.
- **The orchestrator is told to use it by default** in the system prompt itself (not in a
  skill): `agent/src/minisweagent/config/mini.yaml` carries an `<orchestration_rule>` that names
  the four documents, `agent surface` and `agent contract-check`.
- Measured in the web UI against the same task without the store (2 repos, orchestrator + 2
  children): **child discovery tokens ~3,197 → ~1,456 (-54%)**, orchestrator tokens ~26,699 →
  ~12,093 (-55%), and 1 integration bug caught by a subagent that would otherwise have been
  merged. Duplicate reads do not drop — a child still reads the file it edits; what the store
  removes is the orientation work around it.

### Fixed

- **`is_discovery` counted orientation as discovery.** `cd`, `pushd` and `export` inside a
  compound command made a step look exploratory when it was neither. Re-validated against the
  villa journals it had been derived from: 120,718 vs 122,039 reported discovery tokens (1.1%
  off, in the honest direction).
- **The hub put `mini-agent-rs` on a child's PATH but not `mini-tui`**, which the system prompt
  names. The model in a measured run spent ~20 tool calls hunting for it and for bun before
  doing the work it was asked for. It is now resolved the way the runner resolves it
  (`MINI_TUI_BIN`, then `~/.local/bin/mini-tui`) and put, with `~/.bun/bin`, beside the agent.
- **`agent contract-check` run by hand was vacuous**: it looked for `<repo>.md` instead of the
  `surface.<repo>.md` the store actually holds, found no handshake and reported "3/3 pass".
- **A copied template became a false claim.** The handshake block ended with a bracketed
  example and a subagent returned it verbatim; the hub stored it and the contract check failed
  on a file named `<file`. The check was right, the input was garbage: the block now shows a
  filled-in example and a template line is dropped on the way in instead of stored.
- **A large store refused every spawn.** Past the `--context-file` cap a `spawn` failed with a
  message blaming a flag the parent never passed. The store now degrades to a trimmed head and
  says how much was dropped; only an explicit `--context-file` is refused.
- **Integration tests inherited the ambient environment** (`MINI_AGENT_SOCKET`, `MINI_AGENT_BIN`,
  `MINI_AGENT_CONFIG_DIR`), so the children they spawned talked to a *live* session's hub.
  5 of 5 `agent plan` tests failed on `main` for that reason alone.

## 0.37.0 — 2026-10-06

### Added

- **The RLM harness (`mini-agent-rs rlm`), experimental (F6 of the execution order — Fase 6 of
  [`docs/orchestration-plan.md`](docs/orchestration-plan.md))**: a Recursive Language Model
  execution framework in pure Rust inside `agent-rs/`, behind its own opt-in subcommand (nothing
  else in the binary couples to it): a persistent REPL where long-horizon context lives in program
  variables (`let` / `set`, `{{var}}` interpolation) and sub-agents are function calls
  (`def` / `call`) that run their own conversation with the model and the bash tool until they
  answer — recursively, up to `--max-depth`. `ask` is one model turn, `run` is shell, and the
  state (variables and functions, `rlm.json`) auto-persists across restarts (`save` / `load`).
  Scripts run non-interactively (exit 1 on the first error), `-e` runs single statements, and
  scripted `deterministic` models drive `agent-rs/tests/rlm.rs` (shipped as-is from the
  prototype; not executed in this change). No Python and no new dependencies.

## 0.36.0 — 2026-10-06

### Added

- **Shared state, structured results and batch spawns (F5 of the execution order — the RLM-lite
  layer of [`docs/orchestration-plan.md`](docs/orchestration-plan.md))**: `agent state
  ls|get|put` reads and writes the run tree's shared `context/` folder as keys (one file per key,
  atomic replace), and the values become `{{var}}` interpolation targets — `{{context.<key>}}`,
  `{{tasks.<id>.result|status|error|title}}` and `{{artifacts.<file-stem>}}` — resolved into a
  task's text the moment it materializes (spawn, plan launch or batch; unknown vars stay as
  written). `agent result <name> --json` returns a structured result (name, state, exit status,
  result, error, steps, turns, cost, artifacts) instead of prose, and `agent spawn --batch
  file.json` starts many children in one command — each entry its own spawn request, entries
  without a budget splitting what the session has left evenly.

## 0.35.0 — 2026-10-06

### Added

- **Children fork from a compacted conversation (F4 of the execution order — Fase 5 of
  [`docs/orchestration-plan.md`](docs/orchestration-plan.md))**: `agent spawn --fork [--fork-k N]
  [--from NAME]` starts a child from a source conversation's compaction summary plus its last
  messages (default 12, `MINI_AGENT_FORK_K`) instead of cold. The fork is replayed as the child's
  own history (`fork.json`, the same mechanism `agent send` restarts with), so it knows what its
  source knew and later `send` turns continue it with everything in between. `--from NAME` forks a
  sibling (Z2 continues Z1's traj); without it, the fork is of the session itself. The summary is
  capped and the tail drops oldest-first; the budget is the child's own, capped by what the session
  has left, like any spawn.

## 0.34.0 — 2026-10-06

### Added

- **The web task board draws the DAG (Fase 3 of
  [`docs/orchestration-plan.md`](docs/orchestration-plan.md))**: a new `plan.watch` topic on the
  socket hub streams every session's `subagents/plan.json` — nodes with live states, the edges
  (deps), topological layers and a per-status summary on each card. The board shows a session's
  plan above its card (`PlanDag`), pushed whenever a hub updates the plan; nothing is polled
  while nobody watches. `web/src/lib/plan.ts` holds the drawing as pure functions (layers, edges,
  counts, summary) with snapshots in `tests/web-plan-board.test.ts`, and
  `tests/web-hub-plan.test.ts` covers the topic protocol (watch, push, dedupe, unwatch/leave).

## 0.33.0 — 2026-10-06

### Added

- **The hub runs DAG plans with a dynamic scheduler (Fase 2 of
  [`docs/orchestration-plan.md`](docs/orchestration-plan.md))**: `agent plan submit --file plan.json`
  hands the hub a validated DAG (unique ids, existing deps, no cycles) and each task launches
  itself the moment its deps are satisfied — while the parent is in another turn or asleep —
  limited only by the real memory/cost caps and per-group serialization. `agent plan
  add/rm/dep` re-plan in flight, `plan show/graph` inspect (states + ready queue, edges for the
  task board), `plan review <id> ok|fail` accepts or rejects a finished task, `plan retry`
  relaunches a failed one. Successors are born with a **handoff**: their deps' results and
  committed `artifacts` arrive in a `<handoff>` block, and `[plan]` notes report every launch,
  finish, failure and blocked dependent. Everything persists in `subagents/plan.json` next to
  `index.json` (which now carries the plan too).

### Fixed

- A forced spawn (`--force`, or a plan task relaunching a name) now lets the old child's holding
  process go before reusing the name; before, a finished child's process could keep running
  behind the replacement and a relaunch was skipped as "busy".

## 0.32.0 — 2026-10-06

### Added

- **Subagents inherit context (Fase 1 of [`docs/orchestration-plan.md`](docs/orchestration-plan.md))**:
  `agent spawn --context-file F` hands a child what the parent already read (each file arrives as a
  capped `<context>` block), `--brief` turns the task into a validated structured brief (goal, key
  paths, conventions, searches done, decisions — `wrap_brief`), and every run tree gets a shared
  append-only `<run dir>/context/` folder (one file per task for findings/artifacts) that each child
  is told about through a `<shared-context>` note and that grandchildren share too. The cold-start
  re-discovery `mini-agent-rs metrics` measures is what this removes. `skills/subagents/SKILL.md`
  teaches the three layers.

## 0.31.0 — 2026-10-06

### Added

- **Cold-start metrics (`mini-agent-rs metrics`)**: read a run's journal and split every step into
  discovery (read-only listing/searching/reading — what a subagent re-does from a cold start) and
  work, with estimated tokens for each, the commands it ran, and what a brief handing the
  discoveries over would cost instead. Measurement only (Fase 0 of
  [`docs/orchestration-plan.md`](docs/orchestration-plan.md)); `--json` for tooling.

## 0.30.0 — 2026-10-05

### Added

- **Subagents use your connected models, with no extra key.** A run the agent starts itself (a
  subagent on another model, a model switch mid-run) now takes the key of that model from your
  `/connect` providers (`~/.config/mini-tui/providers.json`), as mini-tui already did for the runs
  you start. Before, `agent spawn -m minimax/MiniMax-M3.1-Flash-Preview` from a session failed with
  `HTTP 401` unless `MINIMAX_API_KEY` had been exported beforehand, even though MiniMax was
  connected. Both agents resolve it the same way when the model is built (`models/connections.rs`,
  `models/connections.py`), and a variable you already set still wins.
- **`$subagents` and `$orchestration`: the parent reviews the work and sends improvements back to
  the same subagent.** A subagent's summary is a claim, not proof. The parent now checks the diff,
  the build and the tests itself. When something is missing or wrong it does not fix it itself and
  does not start a new run: it sends a review to that subagent's own session (`agent send`, or
  `orch followup` for detached runs). The review lists each finding with its file and line and the
  check to rerun. The parent reviews again until nothing is left, and moves a subagent stuck 3
  rounds on one finding to a stronger model. The report gains a review-rounds column.
- **Bundled `$e2e-army` skill: agentic e2e tests with TesterArmy's `e2e`.** It teaches an agent to
  set up, write, run and debug [`npx e2e`](https://e2e.tester.army/docs) tests (`e2e.config.ts`,
  `tests/*.e2e.ts`, `agent.act`/`assert` plus exact `expect`, the replay cache, `e2e explore`).
  Agent steps run on MiniMax `MiniMax-M3.1-Flash-Preview` through `@ai-sdk/minimax`. The config
  loads `MINIMAX_TOKEN_PLAN_API_KEY` from `~/.env` because e2e reads no `.env` file itself, and the
  key is never printed. It is installed like `$e2e` and `$subagents`.
- **The model picker no longer offers a `cliproxy/` id the gateway cannot serve.** cli-proxy
  advertises its catalog on `/v1/models` and drops a model from that list when the subscription
  behind it signs out, so `cliproxy/claude-opus-5-5` stayed in the picker while every run of it died
  with `auth_unavailable`. The terminal picker and the web app now read that catalog and annotate
  the entry with a warning, highlighted in the web list. Annotated, not hidden: the id stays
  selectable, because the gateway may be serving it again by the time the run starts. A gateway that
  cannot be reached is left unannotated, since a probe that found nothing is no reason to block a run.
- **`mini-tui doctor [-m <model>]`** - why is `cliproxy/...` failing? cli-proxy is a local gateway,
  so a `cliproxy/` model has four separate things that can break a run: the gateway process, the API
  key both sides must agree on, the upstream subscription's OAuth login, and the model id the gateway
  advertises. All four read the same in a transcript (a refusal, a 401, a 503 in the gateway's own
  jargon), so `doctor` walks them in the order they break a run and names the first one that is
  wrong, with the command that fixes it. Its last stage is mini's own `test-model`, bounded to 20 s
  so a gateway mid-backoff cannot turn a diagnosis into a hang; a green report therefore means a run
  will work, not merely that a port answers. `--json` for scripts.

### Fixed

- **`cliproxy/claude-opus-5-5` works again.** Two things were wrong behind the gateway. The Claude
  OAuth subscription had to be re-logged-in (`cli-proxy-api --config ~/cliproxyapi/config.yaml
  -claude-login -no-browser`, plus an SSH tunnel for the `localhost:54545` callback on a headless
  host) — without it the id vanished from `/v1/models` and every run died with
  `auth_unavailable`. With it back, Anthropic still rejected the model: the gateway advertises a
  built-in `claude-cli/2.1.63` user agent and the API now requires **2.1.280 or newer** for
  opus-5-5. `claude-header-defaults.user-agent` in the gateway config now reports the version of the
  Claude Code actually installed (2.1.281), which is what a real client would send. The gateway
  hot-reloads the config, so no restart was needed.

- **A failed `cliproxy/` run now says which of the four cli-proxy stages broke, above its log tail.**
  The error banner reads the diagnosis from `mini.log` and prefixes it (`cli-proxy (auth): ...`),
  keeping the raw log underneath for the details.
- **A 401 that is the provider's own login is no longer reported as a bad API key.** Behind a gateway
  (cli-proxy, Rosetta) the key mini sends is usually fine while the upstream OAuth token is what
  expired or was revoked, so `OAuth access token has been revoked` now reads "re-authenticate the
  subscription behind this endpoint" instead of sending the user off to edit a working key. Both
  agents (Rust and Python) agree.
- **A refused connect to the local gateway fails in seconds, not after four minutes of backoff.**
  When `cli-proxy` was down, `cliproxy/claude-opus-5-5` reported
  `ProviderError: ... :8317/v1/chat/completions: Connect error: Connection refused (os error 111)`
  only after the full exponential schedule (10 attempts, 4 to 60 s, **248 s**), because the retry
  policy treats every non-abort error the same. A refused TCP connect is the one such error that
  retrying cannot fix by itself - the gateway is not listening, not slow - and the one whose cause
  clears fastest, so it now re-probes at once and caps the rest at 2 s: the same ten attempts
  report in **16 s**. A gateway that comes back mid-retry is caught just as fast as before
  (measured equal at a 3 s restart), and other transport errors keep the shared curve. The error
  now also says what is wrong and what to check instead of only naming the socket.

## 0.29.0 — 2026-10-04

### Added

- **Subagents owned by the session, in Rust (`mini-agent-rs agent`).** Orchestration used to start
  every child as a detached headless run: a Python supervisor, then `mini-tui -p`, then the agent,
  with no control channel. The orchestrator could not talk to a running child, every follow-up was
  a new run replaying the whole history (21 of the 64 runs on this machine), and it learned
  progress by polling with its own steps. Now every Rust session runs a small hub, and the model
  drives it from its bash tool:
  - `agent spawn` starts a child as one process for its whole life, with its own control file kept
    open. A follow-up (`agent send`) is one message to the same process, with all its context, and
    a message sent mid-turn lands before the child's next model call. A child that exited
    continues from its saved conversation under the same name.
  - When a child finishes, fails, stalls or asks something (`agent ask`, from inside it), the
    parent gets a `[subagent <name>] …` message before its next step. A parent that already ended
    its turn is woken by it. No polling.
  - Children stop with their session and count toward its cost limit; a child's budget is capped
    by what is left. After `LimitsExceeded`, the next `send` grants another turn's budget (new
    `STEPS` / `COST` control lines). Children run on the parent's current model by default.
  - `agent ls | wait | result | tail | model | stop` cover the rest. Limits: 8 live children,
    nesting 2 deep. A run that starts no child writes exactly what the Python agent writes (the
    parity suite stays identical).
- **Subagents in the web app and the TUI.** Each child is saved as a session under its parent
  (`parent_id`), and its live agent is announced like any other. The web app shows a strip of
  subagents above the transcript (state, steps, cost): click one to follow it live in the pane,
  and its own strip links back to the parent. `/subagents [name]` lists them or opens one. In the
  TUI, `/subagents` lists them and `/resume` opens one.
- **The `$subagents` skill** (bundled) teaches the loop: split, spawn, keep working, steer, collect,
  verify. `$orchestration`'s `orch` forwards `start`, `followup`, `ls`, `status`, `tail`, `wait`,
  `result` and `stop` to the session's hub when run inside a Rust session. Its detached headless
  runs remain for your own terminal, the Python agent, and runs that must outlive the session
  (`ORCH_DETACHED=1`).

## 0.28.0 — 2026-10-04

### Added

- **The web app and the terminal UI share one live agent per session.** Every UI now records the
  agent it runs for a session (a `live_runs` table in the shared `sessions.db`). Opening a session
  in the web app while a terminal runs it follows that very agent: its output streams into the
  browser as it is written, and a prompt, a model switch or `/compact` sent from the browser goes
  to the same agent through its control file. A prompt typed in the terminal streams into the
  browser and marks the session working. The terminal does the same for a session the web app
  runs. Closing either view only lets go of the agent; the UI that started it decides when it ends.
- **Held web sessions follow the terminal's saves.** A session the web server holds idle is
  refreshed when a terminal saves a newer turn of it, so the next message from the browser
  continues the real conversation instead of forking a stale copy.

### Fixed

- **Clicking a session in the web app no longer fails while a terminal is saving.** Every UI shares
  `sessions.db`, and a terminal rewrites its whole (often multi-MB) transcript every few seconds.
  In SQLite's default journal mode that write locks the file, so the web server's read failed at
  once with "database is locked": the open answered 500 and the pane fell back to a new chat. The
  database is now opened in WAL mode with a busy timeout, so readers never wait for a writer.
- **A failed open is no longer reported as a deleted session.** Only an id that is nowhere answers
  404 (the browser then drops the pane); any other failure answers 503, which the browser retries.
- **Rows written by other UIs are restored defensively.** Unreadable JSON, missing fields and
  oversized outputs degrade to an empty or trimmed transcript instead of failing the open.

## 0.27.1 — 2026-10-02

### Fixed

- **`/compact` in the web app now works after a turn.** It refused with "compaction needs a live
  local run: send a message first" as soon as the session's status left `running` — which it does
  the moment a turn finishes, so the command only ever worked *during* a turn. The gate is now the
  same one the terminal UI applies: an agent holding its control file gets `COMPACT` on it, whether
  it is mid-turn or waiting at its exit. An agent that already left gets a `--compact-only` run over
  the saved conversation, exactly like the TUI's `/compact` between runs (and refused honestly when
  only the plain `mini` CLI is installed). A remote turn is still out of reach: it is one-shot
  `ssh` with no control channel. The refusals now say which of the three cases applies instead of
  always blaming the missing run.
- **An empty `MINITUI_MINI_BIN` / `MINI_BIN` is now read as unset.** A variable left empty by a
  parent process used to override the launcher with `""`, which hid the runner's console script and
  the interpreter read from its shebang, so the agent was misdetected as the bare `mini` CLI
  (`--compact-only`, `--continue` and model switching degraded with it).
- **The compaction reaches the saved conversation as it happens.** The `--compact-only` run the web
  app starts between turns holds at its exit afterwards (for the next prompt), which could be a long
  time: `/resume` and the sidebar served the un-compacted conversation until then.
- **Auto-compaction parity scenarios.** `agent-rs/tests/parity/autocompact.yaml` drives both agents
  past the compaction trigger with no `COMPACT` line, so the automatic path (estimate → summarize →
  keep the tail) is compared between Python and Rust like every other behaviour, instead of only
  the manual `COMPACT` one; `autocompact_window.yaml` does it with the window coming from the
  model's own `context_window` config, the case an unknown model id used to fall out of.

## 0.27.0 — 2026-10-02

### Added

- **`mini-agent-rs e2e`: AI end-to-end tests, in Rust** (`agent-rs/src/e2e/`, guide in
  `agent-rs/E2E.md`). Plain-language goals (`act`) and checks (`assert`) are handed to worker
  subagents (ordinary `mini-agent-rs` runs on the harness' models) that drive a headless Chrome
  through a `browser` command; exact steps and `expect` checks need no model; actions a later
  check confirms are cached and replayed with no model calls. One `e2e.yaml` per project:
  environments, auth profiles (nginx HTTP Basic Auth, login forms, TOTP), secrets by reference
  only (never shown to workers, scrubbed from every file written), and `base_url: auto`, which
  finds the nginx vhost serving the project. Reports: `report.md`, `junit.xml`, `report.json`.
  Subcommands: `init`, `detect-url`, `check-url`, `run`, `last`, `clear-cache`, `skill`.
- **Bundled skills.** mini-tui ships its own skills in `skills/` and installs them into
  `~/.config/mini-tui/skills/` at install, at every TUI / `-p` / web-server startup and with
  `bun run sync-skills`, wherever mini-tui is installed. A newer bundled version replaces an
  unedited copy; an edited copy, a same-named skill of your own, or a deleted one is left alone
  (state in `.bundled.json`).
- **`$e2e`**, the first bundled skill: how an agent finds the binary, sets up `e2e.yaml`, keeps
  credentials out of files and messages, writes `*.e2e.yaml` tests, runs them in the background
  and polls with `e2e last`, and reads the reports. `mini-agent-rs e2e skill` prints the same text
  (it is compiled in), so hosts with only the binary have it too.

## 0.26.3 — 2026-10-02

### Fixed

- **"Does the Rust agent use more tool calls and take longer?"** It does not, and the project can
  now prove it. Both agents send the model byte-identical prompts, so nothing asks the model to do
  more work: same system prompt (read from the same `mini.yaml`), same tools, same observations,
  same limits, same compaction. Two new parity scenarios guard the property directly:
  - `agent-rs/tests/parity/turns.yaml` — a model that batches several independent commands into
    one reply, the way a real agent does. Both agents must take the same number of model turns, run
    the same tool calls and write the same trajectory.
  - `agent-rs/tests/parity/wire_batch.{yaml,json}` — the same over the wire, against the scripted
    HTTP server, with every request body compared byte for byte.

  Measured on one box: both agents reach their first model request with identical prompts, the Rust
  one in ~7 ms against Python's ~173 ms, and the Rust agent runs the same turn count and the same
  tool calls. A run that does take more turns is model-side variation (sampling, or context pressure
  forcing a compaction), not the runner — the guide now says how to tell them apart.

### Docs

- The Rust agent guide has a "Does the Rust agent make more tool calls?" section: what is identical,
  what to check when two runs differ (same model and config, compaction in the transcript, diff the
  trajectories), and why local overhead never adds a tool call. The README says the same in short.

## 0.26.2 — 2026-10-01

### Site and README

- **Panes and windows, front and centre.** The home page opens on the web app's multi-pane screen: four
  sessions side by side in a "Backend" window, with three windows and their status dots in the sidebar.
  It also has a new section, "Every session at once, in panes and windows":
  - the pane menu moving a pane to another window;
  - the same windows on a phone;
  - six points: split like tmux, 12 panes per window, unlimited windows, a dot per pane, moving panes,
    and the same layout on every device.

  The first feature card, the hero text, the badge and a new FAQ answer say the same. The web-app page
  and guide show the screenshots, and the README's Web app section leads with them.
- `web/scripts/windows-shots.mjs` (`bun run windows-shots` in `web/`) makes those screenshots from the
  real built app with invented data. The workspace comes from a mock hub, so no real session, path or
  host can reach an image. A shot is refused unless the page shows what it claims: four panes, the three
  windows, the move menu.
- Markdown images in the docs get the site's base path, lazy loading, their alt text, and a size from
  `#WxH`, so the page does not jump as they load.

## 0.26.1 — 2026-10-01

### Site

- **Python or Rust.** A new guide (`/docs/rust-agent/`) and a section on the home page compare the two
  agents. The numbers were measured on one box with the parity suite's `basic` task, median of five runs:
  - 0.7 ms vs 65 ms to start;
  - 51 ms vs 661 ms per scripted turn;
  - 4.5 MB vs 35.7 MB per waiting session.

  The guide also covers what the Rust agent ports and how parity is kept. **Rust agent** is in the header.
- **Install the Rust agent in one command.** The install guide and the home page download the static
  binary to `~/.local/lib/mini-tui/`, where mini-tui finds it, and show how to verify it against
  `SHA256SUMS` or build it from source.
- The web-app page and guide now cover what came after 0.19: windows of panes, one workspace on every
  device, the status dots, notes and the terminal, the Rust agent, and `sudo`. The version badge says
  0.26.
- **Mobile and width fixes.**
  - The home page scrolled sideways on every phone: the install steps' code could not shrink, so the page
    was 552 px wide on a 390 px screen. The web-app page did the same at 320 px.
  - Long commands now wrap on a phone instead of hiding off the edge.
  - The page container is wider (1280 px, 1440 px on very wide screens), and the docs column grew from
    608 px to 704 to 864 px, so wide screens are no longer mostly empty.
  - The comparison is a table where there is room and labelled cards on a phone.
- Markdown links between docs pages now get the site's base path, so they work on GitHub Pages.
- `bun run layout`: a width audit of every page at 320 to 1440 px that fails on sideways scroll, on
  anything wider than the screen, or on a squeezed column.

## 0.26.0 — 2026-10-01

### Added

- **Landing page and docs (`site/`).** A prerendered SvelteKit site with a home page, a web-app page, six
  docs guides, a changelog rendered from this file, `sitemap.xml`, `robots.txt`, `llms.txt`, Open Graph
  images and JSON-LD. `bun run seo` audits the built pages and `bun run browse` drives them in a real browser.

## 0.25.0 — 2026-10-01

### Changed

- **The web app's workspace is the same on every device, browser and tab.** The windows, their
  panes, which session each pane shows, the status dots and the sidebar's view, pinned and opened
  folders used to live in each browser's localStorage, so every device showed its own layout. They
  now live on the server (`~/.config/mini-tui/web-workspace.json`) and travel over the hub socket
  like notes. A tab is sent the saved workspace when it connects. A change made anywhere (open a
  session, split, move a pane, switch window, rename, pin) shows on every other open tab and device
  at once, with no reload and no polling.
  - What is yours stays in your tab: a half-typed prompt, its chips and the ↑/↓ memory, and the
    interface and text sizes and theme. Another device's change never wipes them.
  - Versioned saves: two devices changing the layout at the same moment end on one and the same
    layout. A stale save never overwrites a newer one.
  - The first browser to load this version seeds the shared copy with the layout it already had.
    Offline, a tab opens on the last workspace it saw, and adopts the server's when it reconnects.
  - The hub socket now opens with every tab, since every tab watches the workspace.

## 0.24.0 — 2026-10-01

### Added

- **A status dot for every pane on the sidebar's window rows**, in reading order:
  - **live** (pulsing): the pane's session is working.
  - **done** (solid green, red for an error): a turn that pane saw running has finished, and the pane
    has not been clicked since. The first click on that pane turns it idle. Switching to its window
    alone does not.
  - **idle** (an empty ring): a new chat, a waiting session, an interrupted turn (your own doing), or
    a finished turn already looked at.

  It works for windows off screen too, and a "done" survives a reload. Each dot has its state in
  words (a tooltip, and the row's screen-reader label). Up to six dots go in a row, so a 12-pane
  window takes two rows and its name still has room.

## 0.23.3 — 2026-10-01

### Fixed

- **Send stopped working in a pane after switching windows** (until a reload). Shelving a window took a
  deep copy of its panes (`$state.snapshot`), which turned each pane's prompt memory, a class, into a
  plain object with no methods. Back on screen, the prompt bar's `memory.push()` threw before the
  message went out, so the Send button did nothing. The panes are now kept as they are. A failure in
  prompt memory can no longer block a send in any case.
- **A shortcut no longer reaches a prompt field it just unmounted.** A split or a window switch from the
  keyboard handed the key on to the old pane's field, which then read its own state after being
  destroyed (Svelte's `derived_inert`: stale values).
- **Pane ids are unique across windows.** Every new window's first pane used to be `p1`, so a lookup
  could find a pane in the wrong window. Clicking a session that one window showed could then empty a
  pane in another. Layouts saved with the old ids are repaired when they load.

### Changed

- **A click on a session that a pane already shows goes to that pane**, switching window when it is on
  another one. No pane changes what it shows, and the pane you were in is left as it was.
- **Live sessions hold their place in the sidebar.** They are ordered by when they started, not by
  their last update, which moved on every step and kept reshuffling the rows. Folders with live
  sessions do the same. Finished and idle sessions stay newest first.

## 0.23.2 — 2026-09-30

### Fixed

- **Parallel runs no longer share a run folder.** A folder was named by second + the first 24
  characters of the task, so two runs started in the same second with a similar prompt (an inlined
  `$skill` makes every prompt start alike) wrote the same `traj.json`, `mini.log` and control file,
  and each headless agent executed the other's task. Folder names now end in a random suffix, and
  the folder is created with a non-recursive `mkdir` that refuses to reuse an existing one.

## 0.23.1 — 2026-09-30

### Fixed

- **`sudo` works in the web app.** The service unit had `NoNewPrivileges=true`, so the kernel ignored
  the setuid bit: every `sudo` an agent ran, or typed in the web terminal, failed with *the "no new
  privileges" flag is set*. The unit now ships in the repo (`deploy/mini-tui-web.service`) with it off,
  and a test keeps it off. `sudo` follows the account's own sudoers rules, as in the terminal UI.

## 0.23.0 — 2026-09-30

The Rust agent is now the default, and the web app groups panes into windows.

### Changed

- **The Rust agent is the default** for the terminal UI, `mini-tui -p` and the web app whenever its
  binary is found: `MINITUI_AGENT_BIN`, `agent-rs/target/release/mini-agent-rs`,
  `~/.local/lib/mini-tui/mini-agent-rs` (new), or `mini-agent-rs` on `PATH`. Without one, mini-tui
  uses the Python agent as before. `MINITUI_AGENT=python` keeps Python on purpose.
- Runs pass `MINI_AGENT_CONFIG_DIR` (the bundled YAML configs) unless one is already set, so a
  binary installed outside the checkout finds `mini.yaml`. Before, such a run failed with
  "Could not find config file".

### Added

- Web app: **windows**, each with up to **12 panes** (was 6 in total). The sidebar lists the windows
  with a pane count, starts a new one, and renames or closes one. Any pane can move to another
  window or to a new one from its menu. Every window is remembered per browser.

## 0.22.1 — 2026-09-30

With `MINITUI_AGENT=rust`, mini-tui now needs no Python at all.

### Added

- `mini-agent-rs title` and `mini-agent-rs test-model`: the session-title generator and the
  providers panel's connection test, which were the last things mini-tui ran through Python.
  With `MINITUI_AGENT=rust` mini-tui uses them; otherwise the Python scripts run as before.
  Both give the same output, exit codes and error text as the scripts (8 parity cases).

### Fixed

- The Rust agent now honors `MSWEA_GLOBAL_COST_LIMIT` and `MSWEA_GLOBAL_CALL_LIMIT` (the whole
  process stops past them, as in Python). Before this, it ignored them.
- The Rust agent's retry waits now match the Python agent's exactly (4, 4, 4, 8, 16, 32, 60
  seconds). They were one step ahead: 4, 4, 8, 16….

## 0.22.0 — 2026-09-29

The agent, rewritten in Rust: same behavior, one self-contained binary.

### Added

- **A Rust port of the agent** (`agent-rs/`, opt-in with `MINITUI_AGENT=rust`). It is a drop-in
  for the bundled mini-swe-agent runner: the same command line, YAML configs, `.env`, `<traj>.json`
  export, `<traj>.jsonl` journal (streamed deltas included) and `MSWEA_CONTROL_FILE` protocol.
  - **The agent:** the full loop, with limits, format errors, plain-text answers and the submit
    marker; resume with tool-call repair; holding at exit for follow-ups; model switches;
    automatic, manual and overflow compaction; SIGINT and SIGTERM, with the command's process
    group killed.
  - **Models:** the OpenAI chat-completions, Anthropic Messages and OpenAI Responses clients,
    behind the same name routing: cli-proxy, Rosetta, DeepSeek, Xiaomi, OpenAI, Anthropic, the
    provider registry and OpenCode Go.
  - **Environments:** the local and docker environments.
  - **Speed and size:** starts in about 2 ms instead of about 190 ms, and a session waiting for a
    follow-up holds about 4 MB instead of about 36 MB. The static musl build needs no Python on a
    remote host.
  - **Parity:** `agent-rs/tests/parity/` runs 24 scenarios through both agents, locally and
    against a scripted HTTP server, and checks that every message, journal line, exit code and
    request body is identical. mini-tui's own 75 tests that drive the real agent pass on it.
  - **Not ported:** the litellm, portkey and requesty classes and the exotic sandboxes.
- `MINITUI_AGENT=rust` / `MINITUI_AGENT_BIN` pick the Rust agent. If the binary is missing,
  mini-tui falls back to the Python agent with a message.

## 0.21.0 — 2026-09-29

An interactive terminal beside the notes, and panes that survive a server restart.

### Added

- **An interactive terminal in the side panel.** Next to Notes, each pane has a **Terminal** tab: a real
  shell in a PTY (Bun's built-in `terminal` spawn), started in the session's folder, or an `ssh -tt` shell on
  its remote host, in its folder. xterm.js draws it: colours, full-screen programs, Ctrl+C, readline keys,
  copy and paste, and resizing follow the panel. It runs over the same hub socket as notes (`term.open`,
  `term.input`, `term.resize`, `term.detach`, `term.close`), with no REST and no polling. Hiding the panel or
  reloading keeps the shell and replays its recent output; **Restart** gives a fresh one, and a shell nobody
  watches is ended after 10 minutes. Output floods are cut to their tail. At most 12 terminals run at once,
  and all of them end with the server. `Ctrl+\`` or `/terminal` opens it. xterm.js loads only when the first
  terminal opens (the main bundle stays at 332 KB). `MINITUI_WEB_TERMINAL=0` turns the terminal off on a
  server.
- **New skills show up without a reload.** The skill list is fetched again when you type `$` or come back to
  the tab (if it is more than a few seconds old), so a skill added on disk while the page is open appears.

### Fixed

- **A server restart no longer turns your panes into new chats.** Open sessions live in the server's
  memory, so a restart (a deploy) forgot them all: every pane's socket got a 404, the page decided the
  session was gone and replaced it with a new chat, and the console filled with "WebSocket connection …
  failed". Now a socket or `GET /api/sessions/:id` for a session the server no longer holds, but that is
  saved in the history, restores it and carries on, and a page loading with panes the server forgot
  reopens them from the history. Only an id that is nowhere, not even saved, is a 404.

## 0.20.0 — 2026-09-29

The web app becomes a workspace: panes, notes, per-folder history, resume from anywhere, and a folder
picker that reaches remote hosts.

### Added

- **`/resume` in the web app**, also from the empty new-chat page. It lists every session saved in the
  database (terminal ones included), grouped by recency and searchable by title, first message and folder.
  Opening one shows its transcript, and sending continues it with the saved conversation.
- `GET /api/history?q=&limit=`, `POST /api/history/:id` and `DELETE /api/history/:id`.
- **Panes**, tmux style. You can split right or down (`Ctrl+\`, `Ctrl+Shift+\`, `/split`, or the pane menu), and
  each pane is its own chat. A pane's first message starts a new session, and all panes stream at once, each
  over its own socket. You can resize with a drag or the keyboard, move between panes with `Alt+1…6`, and close
  a pane with `Alt+X` (its session keeps running). The layout is remembered. On a phone the panes become tabs.
- **Notes** beside every session. A right sidebar in each pane saves as you type, stays in the database and is
  deleted with its session. A save never overwrites a newer one written from another tab. Use `/notes` or
  `Ctrl/⌘+Shift+.` to open it. Notes travel over the hub socket only (see below).
- **Sessions organized by folder.** The sidebar has a **Recent / By folder** switch. By folder lists every
  project folder with saved sessions, most recently active first, each with its count, a running dot and a
  collapsible list of its open and saved sessions (20 at a time, **Show more** for older ones). **Pin** a folder
  to keep it on top, and **New chat here** (the + on a folder) starts a chat already set to that folder. The
  view, pins and expanded folders are remembered in the browser. Search works inside the view and opens only
  the folders with a match. The folder list is one request read from an index. A folder's sessions load
  when you open it, and when a session changes only its own folder is re-read. New endpoints:
  `GET /api/history/folders` and `GET /api/history?cwd=`.
- **Chat history in the web sidebar.** Every session saved in the database appears under **History**, grouped by
  day: terminal sessions, closed ones, and ones this browser never opened. Load more with **Show more**, and
  **All** opens the full Resume panel. The sidebar search box searches the whole database (title, first message,
  folder). Clicking a row opens that chat in the focused pane.
- **Choose the folder a new chat runs in.** The new-chat prompt bar has a **Folder** button that browses the
  machine the chat will run on: this one, or the selected remote host over ssh. You get breadcrumbs, up and home,
  a filter that also takes a typed path (`~/projects`, `/srv/app`), hidden folders on request, git repositories
  marked, and recently used folders. Switching between Local and a host resets the folder. The server refuses a
  local folder that does not exist (400) instead of starting somewhere else. A remote chat and its follow-ups
  run in the chosen folder. New endpoint: `GET /api/folders?path=&hostId=`.
- **The right sidebar goes through one socket hub, never REST or polling.** Notes are watched and saved over a
  single WebSocket per tab (`/api/hub`), shared by every pane. An edit made on another tab or device shows up
  live, and while you are typing it is held back for you to choose. It reconnects by itself and catches up
  after a drop or a server restart. The `/api/notes` REST endpoint is gone.
- **"Session finished" toasts** in the web app, with a **View** button that opens the session in its pane
  (or the focused one) and puts the cursor in its prompt bar. They show for a finish or an error in a
  session you are not looking at. A stop you asked for is not announced. Hovering or focusing a toast pauses it.
- **Prompt memory in the web prompt bar.** Press `↑` on the first line for earlier prompts and `↓` on the last line
  to go forward, then back to your half-typed draft. Recalled commands and skills come back as chips. The memory
  is per session and survives a reload or `/resume`.
- **Interface size** and **text size** in Settings, with `Ctrl/⌘ +`/`−` (Shift for text) and `0` to reset.

### Changed

- **Closing a session in the web app no longer deletes it.** It stays in the history and can be resumed;
  deleting is a separate, confirmed action.
- Sending to a session with nothing saved to continue from answers 409 with the reason.

### Fixed

- Remote web chats were never saved to the history: the database row was only created for local chats, so
  every later save updated nothing. They are saved from the start now, in the folder they run in.

- **The web app asked for `/api/history` about five times a second, forever.** The sidebar's history search
  effect read the list's own loading status to pick its delay, so every answer triggered the next request. It
  now depends only on what you type: one request on load, one per pause while searching, and one when a
  session starts, finishes or closes. The same latent loop was closed in the Settings panel and the app's
  startup. The history store also never sends the same question twice at once.

- WebSocket frames were capped at 64 KB, which would have closed the socket on any long note (for example
  16 000 emoji). The cap now fits the longest allowed note.

- **TUI: after a double-Esc interrupt, `↑`/`↓` scrolled the transcript instead of recalling prompts.** The
  first Esc of the pair had left the prompt, and nothing brought it back. Now focus returns to the prompt.
- **TUI and web: changing the model after a finished or interrupted turn looked like it started work.** In
  the TUI, the "model →" note counted as fresh activity, so the status turned to "working" with nothing
  running. In the web app, a finished agent that was still holding its process open got "from next step", and
  a stop could flip back to "done". A model change now only changes the model. The status stays, nothing is
  sent to the agent, and the note says it applies from your next message.

- Sending a message to a session restored from history failed with "the remote host is no longer
  configured". It now resumes the saved conversation locally.
- The `mini` executable path is read when used, not frozen at import, so tests that point it at a stub no
  longer leak into other test files.

## 0.19.0 — 2026-09-29

The web app grows up: a proper chat, live multi-session streaming, and a settings panel.

### Added

- **Web app** (`bun run web`). A Svelte 5 + Tailwind 4 front end for the same agent, with a sidebar of
  sessions running side by side and a remote mode that keeps the agent headless on a server over SSH.
  Sessions land in the same `~/.config/mini-tui/sessions.db` the terminal UI's `/resume` reads.
- **One WebSocket per session.** `GET /api/sessions/:id/socket` streams that session's transcript as a
  snapshot followed by deltas; the shared SSE stream carries only sidebar metadata. A busy session never
  spends another session's bandwidth, the client reconnects with jittered backoff and a heartbeat, and a
  frame that does not line up triggers a resync instead of a guess. Cross-site handshakes are refused.
- **New chat is a draft.** `/new` shows an empty chat and creates nothing on the server; the first message
  creates the session on the model and host chosen in the draft.
- **Prompt bar.** One line when empty, growing a line at a time up to five and then scrolling. `/` opens
  commands and `$` opens skills (matched by the terminal UI's own code); a pick becomes a chip and is joined
  to the text only when the message is sent. A searchable, provider-grouped model switcher opens from the bar.
- **Settings panel.** Appearance, command-output mode (shared with the terminal), skills, and a providers
  tab that tests a key with a real request before saving it. Keys are never returned: reads carry a masked hint.
- **Loading states and mobile polish.** Skeletons, a pixel-grid loader, 44px touch targets, bottom-sheet
  modals, safe-area insets and `dvh` layout.
- **Streaming replies in the trajectory journal.** The agent journals the in-flight assistant message so a
  live view updates while the model writes (`partial`), and the OpenAI-compatible model streams over SSE.
- **`MiniMax CN`** provider and `MiniMax-M3.1-Flash-Preview` in the MiniMax catalog.

### Changed

- The pure half of `$skill` matching moved to `src/skillMatch.ts` so the browser and the terminal share it.
- `settings.ts` and `sessions.ts` resolve their file paths when called, not at import.

### Security

- State-changing requests must come from the app's own origin (403 otherwise), so another site cannot start
  agents or write provider keys through your browser.

## 0.18.0 — 2026-09-28

Claude Sonnet 5.5 is in the curated model picker.

### Added

- **`cliproxy/claude-sonnet-5-5`.** The cli-proxy gateway advertises Anthropic's new
  Claude Sonnet 5.5, and mini-tui lists it in the `/model` catalog next to
  `cliproxy/claude-opus-5-5`. It runs over the same Claude subscription credential and
  gets the 1M-token context window (automatic compaction) the other Claude 5 models use.

## 0.17.3 — 2026-09-25

The prompt box grows as soon as the text wraps onto a new row.

### Fixed

- **A wrapped prompt row no longer hides below the box.** The box height came from a
  character count (`length / width`), but the prompt word-wraps: when a long word jumped to
  the next row, the textarea needed one more row than the box had, scrolled the first row out
  of view and left the new row hidden until a deleted character shrank the text back. The box
  now takes its height from the rows the textarea actually wraps into (word wrap, CJK and emoji
  widths included), up to 8, and it re-measures when the terminal is resized. When everything
  fits, the text is shown from the top.

## 0.17.2 — 2026-09-25

The skill color also lines up after emoji sequences.

### Fixed

- **`$skill` color after ZWJ emoji, skin tones, flags and decomposed accents.** 0.17.1 still
  shifted the violet after a multi-code-point character (`👨‍👩‍👧`, `👩‍💻`, `🏳️‍🌈`, `👍🏽`, `e` +
  U+0301): the highlight offsets added one column per extra code point. The offsets were
  measured with a test helper that labels cells by code point, which is wrong for these
  characters. Highlight offsets are now pure display columns per grapheme. The prompt render
  tests read the colors from the frame buffer's cells, so they check what the terminal
  actually shows.

## 0.17.1 — 2026-09-25

`$skill` search finds skills by any word, and the skill color stays on the `$name`.

### Fixed

- **`$` search matches any word of the skill name, in any order.** The panel only matched
  names that started with or contained the query exactly, so `$body` found nothing. It now
  ranks prefix matches first, then word starts (`$body` → `pr-body`, camelCase too), plain
  substrings, words in any order (`$body-pr`, `$loop.fix` → `pr-fix-loop`), and in-order
  letters (`$bdy`).
- **The skill color covers exactly `$skill_name`.** Highlights used JS string indices, but the
  prompt textarea counts display columns and skips newlines. After a line break, a tab, a wide
  character (CJK, emoji) or a decomposed accent, the violet moved onto the next word
  (`r-body t`). Highlight ranges and cursor offsets are now converted for each grapheme, so
  completion and editing around a `$skill` mid-phrase also use the right position.

## 0.17.0 — 2026-09-25

mini-tui runs headless: `mini-tui -p "<prompt>"` runs a session with no TUI and prints the
answer, like `claude -p` / `opencode run` / `pi -p`. The TUI's other controls now have CLI
subcommands too.

### Added

- **`mini-tui -p` / `--print`.** Runs one turn of the integrated agent without the UI and exits
  with the run's status (`0` submitted, `1` failed or hit a limit, `2` usage error, `130`
  interrupted). Quiet by default: only the final answer goes to stdout. `-v/--verbose` streams
  every step (commands, outputs, notices) to stderr, and `-q/--quiet` also drops the error tail.
  - `-o text|json|stream-json` (`--json`): one result object (`result`, `session_id`,
    `cost_usd`, `num_steps`, `trajectory_path`, …), or JSON lines as the run happens
    (`init`, one line per event, then `result`).
  - Headless runs are saved sessions: `--continue` follows up on the latest session of the
    folder, `--resume <id|prefix>` follows up on any session, `--compact` compacts one, and
    `--no-session` saves nothing. Sessions started with `-p` show up in the TUI's `/resume`, and
    TUI sessions can be continued with `-p`.
  - Piped stdin is appended to the prompt (`git diff | mini-tui -p "review this"`). `$skills`,
    `/connect` providers and the last `/model` pick work as they do in the TUI.
  - Guard rails for unattended runs: `--max-steps`, `--cost-limit`, `--timeout`, `--cwd`.
- **Scripting subcommands** (all with `--json`): `sessions [list|show|rm]`, `models`,
  `model [<id>]` (sets the default model, like `/model`), `skills`,
  `settings [output-mode|theme <v>]`, plus `--version`.

### Changed

- The CLI parser rejects unknown commands and options (exit `2`), where it used to show the help
  or ignore them. `mini-tui --help` exits `0`.
- `-c key=value` specs now merge into the default config instead of replacing it: a lone
  `-c agent.step_limit=5` used to drop the whole `mini.yaml` prompt config.
- Headless paths and subcommands start without loading OpenTUI/React.
- `MINITUI_DB_PATH`, `MINITUI_RESUME_DIR` and `MINITUI_SETTINGS_PATH` override where sessions,
  resume files and settings are stored (hermetic tests, per-project stores).

## 0.16.2 — 2026-09-24

OpenCode Go runs can finish again, instead of looping until the gateway aborts them.

### Fixed

- **OpenCode Go chat models can give their final answer.** mini forced `tool_choice: "required"`
  on every Go `/chat/completions` request, but a run only ends when the model replies in plain
  text without a tool call. The model could never finish: one `deepseek-v4.1-flash` session
  spent ~600 of its 1,204 steps on `echo "END"` / `echo "FINAL"` until the prompt reached ~370k
  tokens and the gateway failed. `tool_choice` is now left at the default (`auto`);
  `parallel_tool_calls: false` stays, and an explicit `tool_choice` in your config still wins.
- **Opaque OpenCode Go 400s are retried.** A 400 whose body is only an echo of the request
  (`{"model":"deepseek-v4.1-flash"}`, no error text) aborted the run with `ProviderAbortError`,
  although the same request succeeds when sent again. Such replies now go through the normal
  retry policy. Real 400s (invalid request, unknown model, bad key) still abort at once.

## 0.16.1 — 2026-09-24

Long sessions stay under 200 MB: tool outputs are kept only as far as the UI can show them.

### Fixed

- **Huge tool outputs no longer stay in RAM.** Every observation kept its full `raw_output`
  (one `cat` of a big file was 20–30 MB), although a card never shows more than 500 lines or 40k
  chars (the collapsed view shows the last 12 lines). Outputs are now bounded to that: head lines,
  a `… N lines hidden …` marker, then the tail. Collapsed, trimmed and expanded cards look the same
  as before. Trajectory files on disk stay complete.
- **Saved sessions with huge transcripts are bounded when restored.** `/resume` open and preview
  bound them too, so sessions saved before this fix don't bring their outputs back into memory.
- **`/resume` lists metadata only.** Each page ran `SELECT *` and loaded the full
  `events_json`/`messages_json` of 8 sessions (up to 148 MB each in a real database). Preview and
  open now load one row when you ask for it.
- **Journal ingest decodes line by line** instead of as one big string per delta, and it no
  longer keeps the whole read buffer alive through the partial-line tail.

Measured by replaying real journals into `view --follow` (200×50 terminal):

| Journal | Before | After |
| --- | --- | --- |
| 47 MB / 1583 msgs (one 20 MB output) | 200–230 MB settled, JS heap 75 MB | **160–170 MB**, heap 34 MB |
| 38 MB / 260 msgs (one 30 MB output) | 228 MB | **140 MB** |

`bun scripts/repro-memory.tsx <traj.jsonl>` reproduces the measurement.

## 0.16.0 — 2026-09-24

New terminals start on your last model, `/resume` previews sessions, and agent commits carry your identity.

### Added

- **New terminals start on the model you picked last.** Every `/model` pick (in any session) is
  remembered in `~/.config/mini-tui/last-model.json`, and a freshly launched mini-tui uses it as
  its default. It is read only at startup, so TUIs that are already open keep their own model.
  Precedence: `-m` > `$MINITUI_MODEL` > last picked model > mini's default.
  (`MINITUI_LAST_MODEL_PATH` overrides the file location.)

- **Preview a session from `/resume`.** `→` (or clicking `[→ preview]` on the selected row) shows
  that session's transcript read-only in the same panel — tasks, replies, tool calls with their
  return codes and a peek at outputs — so you can tell what it was about before opening it.
  Scroll with `↑`/`↓`, `PgUp`/`PgDn`, `g`/`G`; `←`/`Esc` back to the list; `Enter` opens it.

### Fixed

- **The error console can be closed.** When something threw mid-conversation, OpenTUI popped its
  debug console over the transcript and offered no key to dismiss it. `esc` now closes it (the key
  is consumed, so it does not also interrupt the run), `ctrl+\` toggles it, and its title says so.

- **Agent commits are authored by you.** Runs export `GIT_AUTHOR_*` / `GIT_COMMITTER_*` from the
  account logged into `gh` (name + GitHub noreply email), falling back to `git config --global
  user.*`. These override any `git -c user.name=claude ...` the model improvises, so commits no
  longer show up on GitHub as "claude" or an unknown user. Explicit `GIT_AUTHOR_*` /
  `GIT_COMMITTER_*` are respected; `MINITUI_GIT_IDENTITY=0` disables it.

## 0.15.0 — 2026-09-24

`/compact`, inline skills and a mini-tui skills folder synced from Claude Code.

### Added

- **`/compact`** summarizes the conversation at any time. During a run it reaches the agent over
  the control channel (`COMPACT`) and applies before the next model call. Between runs it
  compacts the saved conversation with the integrated runner (`--compact-only`), and the next
  prompt continues from the compacted view. The transcript shows `Compacting...` and the status
  line reads `compacting · Ns`. The agent's journal reports `info.compacting`, so automatic
  compactions show the same state.
- **`$skills` anywhere in the prompt.** `$` opens the skills panel at the cursor, mid-phrase,
  filtering as you type. `Enter`/`Tab` inserts `$name ` (punctuation typed right after replaces
  the space). Known skills are painted in the skill color. Every referenced skill's SKILL.md is
  sent in one `<skills>` block ahead of the prompt, which reaches mini verbatim. The transcript
  shows the prompt as typed. Unknown names stay plain text, and a notice lists them.
- **mini-tui skills folder** `~/.config/mini-tui/skills/`, synced from `~/.claude/skills` at
  startup and at `bun install` (`bun run sync-skills`). It copies only missing skills, resolves
  symlinks and flattens `synced/<bucket>/` layouts. It never overwrites a skill and never
  re-imports one you deleted. New imports show once as a notice.

### Fixed

- Messages that arrive while the agent waits at exit (a follow-up after a `/compact`, or the
  compaction itself) are journaled again: the journal index skipped the message after an exit.
- **No more `HTTP 400` from Claude after a follow-up that lands mid-command.** A prompt sent
  while a tool call had no result yet left `tool_use` without a `tool_result`, and Claude rejected
  every later request. Unanswered calls now get a placeholder result (also when resuming older
  trajectories, parallel calls included). Existing results are never duplicated.

## 0.14.0 — 2026-09-24

Long sessions no longer die at the context limit, and prompt caching survives compactions.

### Added

- **Automatic context compaction.** Once the prompt reaches 80 % of the model's context window
  (800k for claude-opus-5-5), the agent asks the model for a structured summary (goal, facts,
  files, errors, done, pending, next step) and continues from system prompt + first task +
  summary + the newest messages verbatim. Every user request from the summarized part is copied
  word for word. The trajectory stays append-only (the summary is one extra message), so the
  journal, the transcript and `--resume` keep working. Replayed on the real session that failed
  with `prompt is too long: 1000243 tokens > 1000000 maximum`, it compacts once at 804k → ~67k
  and ends around 165k.
- **Overflow safety net.** A context-overflow error compacts and retries once, and the real
  limit parsed from the error is saved in `context_windows.json` so later runs compact in time.
  A single command output larger than the window is elided in the request only.
- **Rolling cache breakpoints** (`set_cache_control: rolling`, the new default for Claude on
  cli-proxy and Anthropic direct): up to 4 markers on the head, the latest summary, the end of
  the previous step and the last message. The head stays cached across compactions and the
  summarizer call reuses the previous step's cache. `MSWEA_CACHE_TTL=1h` forwards a TTL.
- The TUI shows compactions as one line:
  `→ context · compacted (auto): 804k tokens of 1000k window, 640 messages summarized`.
- Knobs: `MSWEA_AUTO_COMPACT=0`, `MSWEA_COMPACT_THRESHOLD` (0.8), `MSWEA_COMPACT_MAX_TOKENS`,
  or `agent.compaction` in the config. See `docs/mini-swe-agent-patches.md` §8.

## 0.13.2 — 2026-09-24

Long-run TUI ingestion and transcript pairing now stay incremental.

### Performance

- Append-aware transcript item indexing removes the full pairing rebuild from live journal updates.
  The randomized equivalence suite covers late observations and prefix replacement; a terminal-free
  8,000-step stream now takes about **4 ms**, versus repeated full rebuilds that grow quadratically.
- The trajectory parser state and retained slim-message reuse from 0.13.1 remain enabled, so the
  combined path processes 10,002 messages in about **11–12 ms**.
- Existing journal, resume, pairing, and rendered-event shapes are unchanged.

## 0.13.1 — 2026-09-24

Long-run TUI ingestion now scales with the new journal delta instead of transcript history.

### Performance

- The trajectory parser carries task state across append-only snapshots, avoiding an O(n) prefix
  scan on every journal poll. The terminal-free `bun run benchmark:tui -- 5000` workload
  processes 10,002 messages in about **11–12 ms** on the release machine.
- The live App reuses its retained slim message array and skips no-op `RunInfo` state updates.
  Existing journal, resume, and rendered-event shapes are unchanged.

## 0.13.0 — 2026-09-23

Integrated agent runner: less RAM, faster startup, and a smaller default install.

### Added

- **mini-swe-agent is now a first-class mini-tui runner.** Normal TUI runs use the bundled
  `mini-swe-agent-tui` module/console entry instead of loading the public Typer/Rich interactive
  CLI. The same config precedence, model loop, journal, resume format, and control-file protocol
  remain shared with `mini`; custom or older agents automatically fall back to `mini`.
- A reproducible cold-start benchmark at `scripts/benchmark-runtime.py`.
- `mini-swe-agent[benchmarks]` keeps SWE-bench/ProgramBench datasets out of the default install;
  `mini-swe-agent[full]` still installs them.

### Performance

- Deterministic seven-process benchmark: public `mini` **~205–212 ms / ~39 MiB peak RSS** vs the
  integrated runner **~160–170 ms / ~34 MiB** (about 20% faster and roughly 5 MiB less RSS). The runner
  does not import Typer, Rich, prompt_toolkit, or the interactive agent on the normal yolo path.
- The TUI transcript mount budget is now viewport-aware (two viewports, 24–120 items), retaining
  `g`/`G` history paging while reducing native buffers on ordinary terminals.
- **Long-run ingestion is O(delta).** The parser now carries task state across append-only journal
  snapshots and reuses the retained message array; the terminal-free benchmark at
  `bun run benchmark:tui -- 5000` processes 10,002 messages in about **11–12 ms** instead of rescanning
  the trajectory prefix on every poll.

### Fixed

- The bundled agent now installs correctly with older pip versions as well as current PEP 660
  installers; the documented `pip install -e ./agent` path exposes the new console entry point.
- Each TUI run owns its control-file environment, so a run cannot attach to a previous session's
  follow-up channel.

## 0.12.6 — 2026-09-23

Fresh start sin parpadeos: shell → lienzo oscuro → UI.

### Fixed

- **El fresh start con `mini-tui` ya no parpadea: shell → lienzo oscuro → UI.** Medido con un
  grabador de estados de pantalla (lo que el terminal muestra, muestreado a 50 Hz) sobre el
  comando real: antes existía un estado **en blanco** entre el shell y la TUI en cada versión
  (55 ms en 0.12.3 — más el segundo repintado · 250 ms en 0.12.4 · 165 ms y shell borrado en
  0.12.5). Ahora el swap a la pantalla alterna se rellena en el **mismo lote sincronizado**
  con el color de fondo de la app: el terminal nunca muestra su blanco y la UI se “despliega”
  sobre el lienzo oscuro en ~30 ms, con una sola pintura de contenido. 0.12.5 había roto
  además la vista del shell al iniciar en modo main-screen (la limpiaba): vuelve el modo
  alternate-screen nativo, con sus diffs por frame y restauración normal al salir.

## 0.12.5 — 2026-09-23

Apertura continua: shell → lienzo oscuro → UI.

### Fixed

- **La apertura es continua de verdad: shell → lienzo oscuro → UI, sin parpadeos.** El
  arranque ahora mantiene tu pantalla del shell visible mientras se asientan las respuestas
  de capacidades del terminal (antes se entraba a la pantalla alterna en blanco y el
  contenido llegaba ~250 ms después — el “flash”). El swap al alternate screen y un relleno
  con el color de fondo de la app salen en **un solo lote sincronizado**, así que ni el
  blanco por defecto del terminal ni un hueco vacío se ven ni un instante: la UI “despliega”
  sobre el mismo lienzo oscuro, con una sola pintura de contenido (sin el segundo
  repintado a pantalla completa). Al salir se restaura la vista del shell.
- **La paleta de comandos ya no se desborda de la pantalla.** Con muchas conexiones BYOK
  (p. ej. los 32 modelos de OpenCode Go) la paleta de `/` dibujaba todas las filas y el
  contenido pisaba los bordes y la línea de estado. Ahora hay una ventana de 12 filas en
  torno a la selección (como en `/connect`).
- **Los tests de render ya no leen tu `providers.json` real** (`MINITUI_CONNECTIONS_PATH`
  los aísla) — el estado de tus conexiones cambiaba resultados de tests.

## 0.12.4 — 2026-09-23

Sin flash al abrir — una sola pintura de contenido.

### Fixed

- **The open flash is gone — the UI paints exactly once at startup.** The 0.12.1 fix removed
  the scrollbar’s accidental second paint, but the terminal’s *capability replies* (colour,
  cursor and mode queries — answered by tmux/terminals a round-trip after the probes) each
  invalidated the renderer and forced a **second full-screen repaint of identical content**
  ~15 ms after the first — the “full screen terminal re-render” flash that survived. The UI
  now mounts after the startup reply storm settles (input is observed, never consumed: quiet
  for 60 ms, at least 120 ms, at most 800 ms), so those invalidations land on the blank
  alternate screen instead of on content. Measured byte-for-byte under tmux and on a bare
  PTY: one content paint, no rewrite.

## 0.12.3 — 2026-09-23

The connection test actually runs — valid keys work everywhere now.

### Fixed

- **The `/connect` wizard's connection test actually runs now** — the last missing piece behind
  “valid key, still errors” on every provider. The helper interpreter resolver read the `mini`
  launcher as a *relative file path*: with `mini` living on PATH (the usual case) that read
  always failed, and every helper script silently fell back to whatever `python3` sits first on
  PATH — when that python cannot `import minisweagent`, every model test failed with
  “could not reach … with that key” no matter how valid the key was. The resolver now searches
  PATH for the launcher and understands both shebang styles (`#!/usr/bin/python3.10` and
  `#!/usr/bin/env python3.11`); `MINITUI_PYTHON` still overrides. Session-title generation (the
  other helper script) was silently falling back for the same reason and benefits too.

## 0.12.2 — 2026-09-23

Valid OpenCode Go keys test green again — on every model.

### Fixed

- **The `/connect` connection test now passes on every OpenCode Go model** (verified live with
  a real key across all three endpoint flavors). Three distinct bugs made valid keys look
  broken:
  - **Messages flavors (MiniMax, Qwen)** — every request died on an `AttributeError` in the
    direct Messages client (a module constant read as a member) and burned ten retries before
    failing, and the OpenAI-style `tool_choice`/`parallel_tool_calls` mini sends to keep the
    agent loop moving are rejected by that API (Qwen even rejects `{"type": "any"}` — the
    client now translates the shapes and falls back to unforced tools on strict flavors);
  - **Responses flavors (GPT 5.6 Luna, Grok 4.6/4.7, Muse Spark)** — a plain-text answer
    raised a format error instead of counting as the final answer, so the one-word connection
    probe could never succeed. Text without tool calls is now the final answer here too (the
    same rule as the chat client — patch §1);
  - **Chat flavors (GLM, Kimi, DeepSeek, MiMo, LongCat, Hy, Space Bunny)** — the connection
    was fine, but the probe counted a tool-call reply (`bash: echo ok`) as “unreachable”.
    Coding models answer one-word prompts that way often; a tool call proves reachability
    just like text.

## 0.12.1 — 2026-09-23

One paint at open — no more full-screen second render.

### Fixed

- **The TUI paints once at open — no more full-screen second render.** Opening flashed a
  second full paint ~15 ms after the first: the transcript's scrollbar rendered *visible*
  before the first layout settled, then the next frame erased it — a full-height stripe
  repainting down the right edge of the whole screen. The scrollbar now starts hidden and its
  visibility is managed with the thread itself (and re-checked on resize): one clean paint at
  startup, and the overflow thumb is still there whenever the thread is taller than the view.

## 0.12.0 — 2026-09-23

Long keys, whole keys — and you can look at them.

### Fixed

- **Long API keys no longer look truncated in the `/connect` key field.** The mask drew at
  most 32 `•` no matter how long the key was, so a pasted 51-char key (e.g. an OpenCode Go
  `oc_sk_…`) looked like the paste had been cut. The value was always stored complete — the
  mask now shows one marker per character, exactly.

### Added

- **Tab shows/hides the key** in the `/connect` key field (masked by default, clear text on
  demand — handy for verifying what pasted). The hint line says so.

## 0.11.0 — 2026-09-23

Find models and providers by name.

### Added

- **Search in the `/model` and `/connect` provider modals.** Both lists take a name search
  now — type or paste to filter (the picker's focused select keeps ↑/↓ and Enter), with a
  `no match` line for dead ends. The `/connect` model step and the `/resume` browser already
  had theirs.

## 0.10.1 — 2026-09-23

Paste your API key — for real this time; the Go catalog matches the docs again.

### Fixed

- **Pasting into the `/connect` API key field works now.** The wizard's inputs are display-only
  and never handled paste, so the key had to be typed character by character. Bracketed pastes
  (the usual ctrl+shift+v / shift+insert in modern terminals) are wired into the key field, the
  model search and the `/resume` search; ctrl+v and shift+insert read the system clipboard
  directly (wl-clipboard · xclip · xsel · pbpaste · tmux buffer); and pastes that arrive as
  plain input bursts land as one token. Pasted keys collapse to a single whitespace-free token
  (line-wrapped clipboard values included).

### Changed

- **The OpenCode Go catalog matches the docs `Endpoints` table** (32 models). Added with their
  documented prices and limits: `grok-4.7` (responses, tiered above 200K like 4.6),
  `MiMo-V2.6-Flash` / `MiMo-V2.6-Pro` (chat) and the free-for-now `Space Bunny Free` (chat,
  replacing `union-alpha` as the promo model). The TUI's static fallback list drops the ids
  the docs no longer advertise (`glm-5`, `grok-4.5`, `kimi-k2.5`, `mimo-v2-omni`, `mimo-v2-pro`,
  `omen-alpha`, `ox-alpha-free`, `qwen3.5-plus`), and the pi sync fallbacks cover the new ids.

## 0.10.0 — 2026-09-23

Your prompt is on screen the instant you send it; the model's thinking can be too.

### Added

- **Your prompt is on screen the moment you send it.** The task card used to wait for the
  first journal write — which lands with the first assistant reply — so every prompt left a
  visible gap before it appeared. The TUI now echoes the task immediately (typed prompts,
  post-run follow-ups and `mini -t` run mode alike), and mini writes the prompt to its
  trajectory journal *before* the first model call (control-file follow-ups too), so the real
  transcript confirms the echo right away. Sent twice-by-later-parsing tasks dedupe to one.
- **The model's thinking, in the same three states as tool outputs.** mini-swe-agent captures
  chain-of-thought from all three provider flavors — `reasoning_content`/`reasoning` (DeepSeek,
  Qwen), Anthropic `thinking` blocks (incl. redacted ones and replay signatures), and OpenAI
  Responses `reasoning` summaries (live deltas do not exist here: the agent's query is a single
  non-streaming call, so the thinking arrives complete with the reply). It renders above the
  reply: `expanded` shows it in full, `trimmed (2 lines)` at most two lines, `collapsed` shows
  just “Thinking...” while the model works and “Thought for {n} seconds” once it answers
  (per-reply timing recorded as `extra.thinking_seconds`). The live “Thinking...” tail shows
  in every mode while a turn is in flight.

## 0.9.0 — 2026-09-23

Every provider on its own direct base URL; litellm becomes an optional extra.

### Changed

- **litellm is detached: every provider runs on its own direct base URL.** DeepSeek, OpenAI,
  Anthropic, Moonshot, Zhipu, Groq, Z.AI, MiniMax and OpenRouter now call their endpoints
  directly — three thin clients (OpenAI chat, Anthropic Messages, OpenAI Responses) with
  zero litellm imports on any run path. `litellm` becomes an optional
  `mini-swe-agent[litellm]` extra that only backs the opt-in `--model-class litellm`
  escape hatch. Everything litellm silently provided is now explicit: cost tracking ships
  in `models/prices.py` (per-provider price rows — DeepSeek/OpenAI/Anthropic prices kept,
  OpenCode Go's documented prices and tiered billing included; unknown ids cost 0.0 like
  before), and the protocol quirks carry over 1:1 (DeepSeek id aliases and error rewrites,
  the `gpt-6*` Responses API, the temperature fallback, Anthropic cache markers and
  thinking-block replay, OpenCode Go's three endpoints and session headers).
- **One base URL/env slot per provider** (`ZAI_API_BASE`, `MINIMAX_API_BASE`, `MOONSHOT_API_BASE`,
  …). Two OpenAI-compatible BYOK providers can now coexist — they used to collide on the
  single `OPENAI_API_BASE` slot. Saved connections on that generic slot keep working.
- Unknown model names fall back to the generic OpenAI-compatible client (any endpoint via
  `OPENAI_API_BASE`) instead of litellm's model zoo. `MSWEA_PRICE_TABLE_PATH` adds custom
  price rows; `LITELLM_MODEL_REGISTRY_PATH` is gone with the litellm path.

## 0.8.1 — 2026-09-23

A crash error that scrolls with the chat.

### Fixed

- **A crashed run's `mini.log tail` no longer sticks to the bottom of the chat.** When `mini`
  died mid-run (a `BadRequestError`, e.g. DeepSeek's "Insufficient Balance"), its log tail
  pinned itself below the transcript and stayed there: after switching model and continuing
  the conversation, every newer message rendered above it and the stale error sat at the very
  bottom of the chat thread. The tail is now posted as a transcript item at the failure point,
  so it moves up with the thread as the conversation continues (and clears when the thread
  rebuilds from the resumed conversation on the next run).
- An interrupted run no longer swallows what comes after it: a follow-up run's exit reported
  "interrupted" and its crash tail was never posted.
- An unreadable trajectory posts a transcript notice (it used to show under the mislabeled
  `mini.log tail` block).

## 0.8.0 — 2026-09-22

Faster agent loop: 5× less overhead per step (8.9 → 1.8 ms) and keep-alive to the gateway.

### Performance

- **The agent's own overhead per step is 5× lower: 8.9 → 1.8 ms** (600-step bench, same
  output). This is everything except the model and the command itself.
  - **Young-generation GC per step, full pass every 50 steps.** A full `gc.collect()` walked
    the whole heap on every step and was more than half of the agent's time.
  - **Compiled Jinja templates are cached.** The observation, format-error and system templates
    were re-parsed and re-compiled on every step (~1.5 ms each).
  - **The full trajectory export scales its cadence** to one rewrite per 10 % of new messages,
    and at least every 60 s. It is O(n): ~33 ms at 900 messages. The append-only journal stays
    the always-current copy, and the export still lands at the end of every run.
- **Keep-alive to the gateway.** `cliproxy/` · `rosetta/` · `xiaomi/` reuse one HTTP connection
  across steps, with a transparent reconnect if the gateway dropped it while idle. The TLS
  context is built once, which saves the TCP+TLS handshake on every step for remote HTTPS
  gateways such as Xiaomi.

## 0.7.0 — 2026-09-22

Fase 3 del plan de RAM: `mini` sin litellm para los gateways y una TUI más ligera en vivo.
Una sesión con claude-opus-5-5 vía cliproxy pasa de ~410–560 MB a ~215–250 MB (TUI + mini).

### Performance

- **`mini` without litellm for the gateways.** `cliproxy/`, `rosetta/` and `xiaomi/` models now
  call their OpenAI-compatible `/chat/completions` directly (stdlib HTTP, same trajectory
  shape). A real claude-opus-5-5 run: **peak RSS 214 → 40 MB** and the first answer **~2.3 s
  sooner** (litellm's import alone was 198 MB / 2.1 s). DeepSeek, OpenAI and OpenCode Go keep
  litellm (price tables, protocol adapters). Picking a model class no longer imports litellm.
- The gateway API key is no longer written into the trajectory's model config (`***`).
- **The TUI keeps only the slim conversation.** Once raw messages become UI events, their heavy
  extras (`extra.response`, `extra.raw_output`) are dropped from memory, both in the App and in
  the journal watcher. The trajectory files on disk stay complete, and `--resume` context is
  unchanged. A saved 817-message session shrinks from **5.7 to 3.1 MB**.
- **Fewer transcript saves.** A save happens when a turn ends and at most every 30 s while a run
  streams, instead of 2 s after every change (each save stringified MBs). Quitting and `/new`
  flush the pending save.
- **The spinner no longer re-renders the app.** The working indicator owns its 8 fps tick, so the
  transcript tree stays still. CPU at rest while "working" drops **1.8 → 0.5 %**.
- Live replay of a real 817-message session: CPU **−13 %**, peak RSS **229/241 → 199/211 MB**.

## 0.6.1 — 2026-09-22

An honest status chip and a quieter bottom stack.

### Fixed

- **"● done" while the agent was still working.** The agent keeps a run open at exit to take
  follow-ups, and its journal keeps that exit message. Any exit anywhere in the transcript
  showed "done" (green) through every later turn. The chip now reads the *last* event: an exit
  there means done (or error for a non-`Submitted` exit status), and anything after it is live
  work with the loader. Replaying a real claude-opus-5-5 session: 122 of 129 working snapshots
  showed "done" before, 0 now.
- A follow-up sent to a held-open run restarts the "working · Ns" timer.
- ctrl+c right after fast typing now clears the prompt too (it read a not-yet-synced copy).

### Changed

- **Nothing below the model row.** The hint line under the status line is gone (no
  "sent → …", "copied …", "theme → …", "interrupted — …"). The status line is the last row.
  The ctrl+c close prompt moves into the prompt placeholder, and the rare failures (unknown
  `$skill`, unreadable session) post a transcript notice instead.

## 0.6.0 — 2026-09-22

Skills, prompt memory and sessions without restarts.

### Added

- **Claude Opus 5.5 in `/model`**: `cliproxy/claude-opus-5-5` (Claude subscription through
  cli-proxy) heads the curated model list.
- **`/new`** starts a fresh session without restarting mini-tui: the current run (if any) is
  stopped, its transcript saved, and the view, cost, prompt history and conversation reset. The
  chosen model and settings carry over; the next prompt creates a new saved session.
- **Prompt history.** Every prompt sent in the session (commands and `$skill` calls too) is
  remembered: `↑` on the first line of the prompt recalls older ones, `↓` on the last line walks
  forward and restores the half-written draft. `/resume` seeds it with the session's prompts.
- **`$skill` prompts.** `$` opens a completion palette over `~/.claude/skills` (name +
  description); `$<skill> <request>` sends mini the skill's `SKILL.md` ahead of the request,
  and the transcript collapses it back to `$<skill> <request>`. Unknown skills keep the prompt
  and post a notice.

### Changed

- **ctrl+c: once clears, twice closes.** The first press clears the prompt (and shows
  "ctrl+c again to close"). A second press within 1.5 s closes the TUI, in the prompt and in
  navigation mode. The renderer no longer exits on the first ctrl+c.

### Fixed

- Filling the prompt from the palette parks the cursor at the end, so typing continues after
  `/model ` / `$skill ` instead of before it.

## 0.5.0 — 2026-09-22

Leaner blocks, leaner agent — fases 0–2 del plan de RAM ([docs/PLAN-ram-reduction.md](docs/PLAN-ram-reduction.md)).

### Performance

- **Plain text unless markdown is needed.** Measured per block: `<markdown>` 0.33 MB vs
  `<text>` 0.09 MB (syntax highlighting is free in RAM — 0.32 MB without it — so it stays).
  Task cards render the prompt verbatim as text; assistant/exit bodies only use the markdown
  renderable when they actually have structure. Standard 400-step repro: **279 → 205 MB**
  settled; a plain-prose workload sits at **152 MB** (≈ the app's base).
- **`prompt_toolkit` loads lazily** in the agent (only interactive prompts need it): the `mini`
  import drops **35 → 20 MB** and ~63 ms of startup on every invocation, `-y` runs included.
- The agent freezes interned state after imports (`gc.freeze()`) and collects per step, keeping
  hour-long runs flat.

### Added

- `MINITUI_PROFILE=1` (or `MINITUI_PROFILE=<path>`) samples the TUI's RSS/CPU every 5 s into
  `~/.config/mini-tui/profile.log` for capacity work on real sessions.

### Notes

- `mini`'s remaining ~200 MB during runs is `litellm` (measured: 198 MB retained at import) —
  all six providers route through it. Cutting that is Fase 3 of the plan and needs a decision
  on cost tracking.

## 0.4.0 — 2026-09-22

One repo, one install — mini-swe-agent now lives in `agent/`, and trajectory persistence got
55× lighter.

### Added

- **Vendored mini-swe-agent** (`agent/`, `git subtree --squash` on upstream v2.4.6) carrying the
  three TUI integration patches as real code (plain-text final answer · control file ·
  `--resume`) and the custom model providers (xiaomi, rosetta, cliproxy, deepseek, opencode_go,
  openai, with their `mini extra <provider>-models` listings). One `pip install -e ./agent` and
  `mini` runs it all; [docs/mini-swe-agent-patches.md](docs/mini-swe-agent-patches.md) remains
  as the upstreamable description of the patches.

### Performance

- **Append-only trajectory journal** (`<traj>.jsonl`): the agent appends one line per message
  plus a fresh info line on every save (O(1) per step, never torn), and mini-tui consumes only
  the new bytes per tick. The full `traj.json` export is now compact (no `indent=2`), atomic
  (tmp + rename) and throttled (every 20 messages / 10 s — always written at run end).
  Benchmark on a synthetic 300-step run: **55× less IO** (235 MB → 4.3 MB written) and **8×
  faster persistence** (0.99 s → 0.12 s).
- Trajectories from unpatched producers keep working: the TUI falls back to whole-file reads
  when no journal exists.

### Fixed

- Torn mid-write trajectory reads can no longer happen (atomic export; journal appends are
  single whole lines and partial tails are held back until complete).

## 0.3.0 — 2026-09-22

Lighter and faster. Identical 400-step repro run (200×50 terminal): **−30 % CPU** (18.6 s → 13.1 s)
and **−30 % memory** (peak 323 → 228 MB, settles at 280 → 198 MB).

### Performance

- Transcript cards are memoized with stable per-block callbacks (`StepCard`, `TaskCard`, the new
  `AssistantCard`, `NoticeLine`, `ExitBanner`): the 120 ms spinner tick now re-renders just the
  status line — before, every mounted card re-rendered and re-clipped its text 8×/s.
- Trajectory snapshots parse incrementally — messages are append-only per run, so only the delta
  is parsed and appended instead of rebuilding every event on each step. A replaced file
  (`view --follow` on another run's output) is detected at the message boundary and re-parsed whole.
- `messagesToEvents` scans the consumed prefix without allocating a slice per snapshot.
- Step numbering is O(1) per card (was a linear search per card — O(n²) per render).

## 0.2.0 — 2026-09-22

Memory: long runs no longer grow into the GBs. A transcript keeps every step mounted as native
text buffers (≈1 MB each in practice — every rendered line is a full terminal-width row of
cells), so an all-day run used to grow without bound (5+ GB observed).

### Fixed

- The transcript now mounts in a sliding window of 120 blocks: it follows the live tail, `g`
  pages older steps in (a top hint says how much is hidden) and `G` returns to the live bottom.
- Assistant markdown, task, notice and exit text is now clipped like tool outputs
  (`... N lines hidden ...` marker, plus a hard 40 KB clamp for single-line monsters).
- Expanded / `e` reveal is capped at 500 lines (was 5000 — one flipped-open block could
  allocate tens of MB on a wide terminal).
- Error banner reads only the last 64 KB of `mini.log` instead of the whole file.
- Tool-call pairing is O(n) and memoized (was O(n²) on every render — 8 renders/s while running).
- Session transcript saves are debounced 2 s (was 500 ms); each save stringifies the full
  transcript, so the old cadence churned tens of MB/s of garbage while a run streamed.
- The scrollbox `contentOptions` prop has a stable identity: no layout re-apply on every commit.

## 0.1.0 — 2026-09-22

Initial release.

### Added

- Terminal UI for mini-swe-agent: the harness runs untouched as a subprocess; the trajectory it
  rewrites after every step is parsed into cards (task · assistant markdown · one quiet card per
  bash step) that stream in live (`run`), or render an existing trajectory (`view [--follow]`).
- Claude-Code-style prompt bar with conversational follow-ups (Alt+Enter / Ctrl+J newline) and a
  `/` command palette.
- Output display modes (collapsed / trimmed / expanded) with per-block `e` toggle, and six themes
  with live preview in `/settings`.
- `/model` picker and `/connect` for BYOK providers, `/resume` for sessions saved in SQLite with
  AI-generated titles, and `--resume` conversation continuation.
- Single status line (loader · model · path · branch), double-Esc interrupt, half-screen PgUp/PgDn,
  burst-accelerated mouse wheel and select-to-copy.
