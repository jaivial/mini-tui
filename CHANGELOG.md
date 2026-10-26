# Changelog

All notable changes to mini-tui, newest first. Versions follow [semver](https://semver.org/).

## Unreleased

### Added

- **Google Business Profile MCP, several businesses.** Google has no MCP server for Business
  Profile, so mini-tui's web server now serves one (`/api/gbp/mcp`, loopback only). It proxies the
  Business Profile REST APIs with your Google token: profile info and edits, reviews and replies,
  posts, performance and search keywords. You save businesses (`business_add`) and choose one per
  call or as the default. The login is the Search Console flow (your OAuth client,
  `business.manage`). See docs/google-business-profile.md.

- **Real per-model context windows and output caps.** `config/model-limits.json` covers every
  static BYOK provider and curated catalog id; the Rust and Python agents read it on every model
  construction (so a `/model` switch never keeps the previous model's limits) instead of the
  200k / 4096 fallbacks. `MSWEA_CONTEXT_WINDOW` / `MSWEA_MAX_TOKENS` override it, explicit model
  config overrides both; Responses requests send the cap as `max_output_tokens`. Anthropic models
  now honour their YAML config like the other wire flavours. Unknown and local ids keep their
  dynamic defaults.

### Fixed

- **Google Search Console (and any OAuth MCP server) no longer drops out mid-run.** A run had
  only the access token it was spawned with, and Google's lasts one hour, so long runs, resumes
  and subagents got `401 invalid OAuth` even though the refreshed token was already in
  `mcp.json`. Runs now get `MINI_AGENT_MCP_FILE`. On a 401/403 the agent reloads the server's
  credentials from it, opens a new session and retries the call once. Every process that spawns
  runs keeps the file fresh (the CLI and the channel consumers included). A refresh token the
  provider refuses (`invalid_grant`) now shows as **expired**, not "connected". A failed
  `sites_list` check asks for a new login only when the failure is an authentication error.

## 0.45.0 — 2026-10-25

### Added

- **Deterministic worker closure with fast close + eager verification.** Queue workers capture the
  supplied checker's SHA-256 and require a real passing verdict before `Submitted`. Eager closes
  as soon as the deliverable passes, without another model turn. `verify.sh` needs an independent
  `PASS` line; masked failures, tracebacks and checker replacement are rejected. Opt out with
  `MINI_AGENT_TASK_VERIFIER=off`, `MINI_AGENT_VERIFIER_EAGER=0` or
  `MINI_AGENT_VERIFIER_FAST_CLOSE=0`.
- **Opt-in MCP client.** Streamable HTTP initialize/session handling, JSON/SSE responses,
  paginated `tools/list`, `tools/call`, and tool schemas for OpenAI chat/Responses and Anthropic.
  Configure with `MINI_AGENT_MCP_URL`; verify with `mini-agent-rs mcp-tools` (docs/mcp.md).
- **Kimi K3 and MiMo A/B tooling.** Isolated interleaved queue-vs-pi runners, per-task provenance,
  strict invalid-run handling, objective PASS gates, local and Composio-style charts, and a
  validated schema for adding mini's official result once the private benchmark is accessible.

### Fixed

- **Independent fan-out requires disjoint working directories.** `allow_overlap: false` rejects
  overlapping waves instead of serializing N cold starts; shared-root work falls back to one
  worker. Sequential work keeps the previous overlap behavior.
- **Benchmark integrity.** Verifier restoration uses the original task id across `.rN` runs,
  multi-worker makespan is measured correctly, and infrastructure failures are not scored as
  ordinary task failures.
- **Docker GitHub auth diagnosis.** Entrypoint warns when gh credentials are not file-visible,
  covering desktop keyrings that do not cross the container boundary.

### Measured

- Fast close + eager: **2.85x worker with 30/30 PASS on mini and pi** (`queue-20261024-211031`).
- Strict final binary: **2.43x worker / 1.84x e2e**, 10/10 on both (`queue-20261024-222316`).
- Tests: 91 queue/bridge TypeScript checks, 7 closure tests, 2 MCP tests, 4 chart tests.

## 0.44.0 — 2026-10-23

The docker release: the whole runtime in one image, with the tools that keep the container from
becoming a sandbox — `gh` and `ssh` work inside it exactly like in the terminal outside. This
release covers everything since 0.43.0.

### Added

- **mini-tui in a container.** `docker compose up -d` brings the web app on 4317 with the whole
  runtime baked in the image (bun, node, python+agent, whisper.cpp + ggml-small, mini-agent-rs);
  state lives in the bind-mounted home at identical paths. Profiles: `channels` (WhatsApp consumer)
  and `rag` (RAG server + graph projection). `network_mode: host`, SELinux handled (`label=disable`,
  measured `EACCES` on the mounted home without it). See [docs/docker.md](docs/docker.md).
- **The container is not a sandbox: `gh` + `ssh` parity with the host terminal.** `gh` (official
  `cli/cli` tarball, pinned) lands at `/usr/bin/gh` — the exact path the mounted `~/.gitconfig`
  calls for git's credential helper — and `openssh-client` is in the image; GitHub auth
  (`~/.config/gh`) and your ssh config/keys (`~/.ssh`) ride the home mount. `gh pr create`,
  `git push` and `ssh <host>` in an agent session are the same actions as outside. A regression
  test pins the contract (`tests/docker-host-parity.test.ts`). Documented limit: a passphrase-
  protected ssh key needs the host's `ssh-agent` (`SSH_AUTH_SOCK` mount).
- **Terminal-Bench sample F1** (10 tasks) and the nx8/nx4b corpora: mutually foreign minutes-scale
  parts, with the Nx regime and turn batching.
- **ContextStore launch-time dedup** against graph-RAG hits, with reconciled docs.

### Fixed

- **A pasted API key is no longer condemned by a non-chat model** first in the catalogue (#412):
  the connect flow validated the key against `models[0]` of the live `/models` list alone — sorted
  alphabetically, and for xiaomi that is `mimo-v2.5-asr`, a speech model that answers a chat
  completion with `400 Param Incorrect`. Measured: pasting the CORRECT xiaomi key answered
  "could not reach xiaomi/mimo-v2.5-asr with that key". The probe now walks chat-looking
  candidates until one answers, and the first that answers becomes the connection's default model.
- **A failed connect says what the provider actually answered** (#413): the probe helper discarded
  the child's stderr and the model-list failure was swallowed silently, so an expired key, a wrong
  model id and a missing agent binary all collapsed into the same mystery sentence. A refusal now
  carries the provider's own words (key redacted).
- **kimi for coding works end to end** (#413) — temperature 1, no thinking parts, honest errors:
  its endpoint accepts only `temperature: 1` (measured: HTTP 400 "invalid temperature: only 1 is
  allowed for this model" at the agent's 0.2 default — the key was valid all along) and refuses
  Anthropic `thinking` parts replayed from a Messages-protocol history (HTTP 400 "invalid part
  type: thinking"). The connection pins the temperature for probes and runs both, and the
  OpenAI-compat wire never sends thinking blocks again.
- Markdown bullets are not a split signal in the router; goal-oracle caps at one reopen and
  protects pre-existing files.

### Changed

- **Prompting: act, don't rehearse.** Targeted edits over full-file rewrites, with the measured
  cost of pre-edit thinking storms documented per turn.
- Model defaults: deterministic sampling (`MINI_AGENT_TEMPERATURE=0`), thinking budget 512 by
  default and for wave workers, temperature 0.2 default.
- P1 router + P2-D fan-out policy: delegate only what splits, in one wave.

Also merged since 0.43.0: web sidebar and kanban hardening, incremental subagent journals, paged
transcripts in recoverable batches, and open-session recovery after a server restart.

## 0.43.0 — 2026-10-19

mini-tui is now a team of bots that organize work as a kanban, with workers that carry the cards out,
WhatsApp groups synced with the web app, a real browser through cu, and a closure check that makes
"done" mean "the evidence is on the card". This release covers everything since 0.42.0, with a new
README and a new landing page.

### Measured

- **Closure check on, against pi: 112.9 s vs 145.6 s, 30/30 PASS on both sides.** Ten tasks, three
  interleaved repetitions (pi and mini alternate per task, so API drift hits both alike),
  `MiniMax-M3.1-Flash-Preview` on both sides, mini on the deployed binary and config with Laya as the
  judge. That is 0.78x of pi's time as the sum of per-task medians, and mini is at least as fast on 9
  of 10 tasks. Ten tasks, three repetitions, one model, one machine; earlier rounds were a tie and
  [the report](docs/pi-vs-mini-benchmark.md) keeps them.
- **Where it came from.** Baseline with the model judge: 7 of 27 runs hit the 900 s timeout, because
  the judge rejected finished work up to 158 times (#300 caps rejections at 3). Laya had always
  answered "evidence truncated" and sent every closure to the slow model judge (#302 gives it a
  compact window). Its latency grows steeply with input, about 5 s per closure at 17k characters
  (#303 shrinks the window, and a closure now costs about 0.1 to 0.5 s).

### Added

- **Bots and a board.** Windows hold bots and each bot holds the delegates it started: a nested
  sidebar, a team map drawn as a live graph, and a read-only view of other bots' cards through a
  shared graph layer. The durable task graph keeps leases, so a card in flight is not lost when a lane
  stops.
- **WhatsApp groups, synced both ways** (WA-2 to WA-7, v4 to v6). One group per bot, group photos from
  the bot avatars, a no-echo mirror between the group and the web app, bounded media with local voice
  transcription, a 👀 acknowledgement, typing state, semantic reactions, `/newsession` and `/rename`,
  and pairing with a phone code or a QR.
- **cu in the agent.** The `computer_use` tool drives a reusable pool of cu daemons and posts
  screenshots to the chat.
- **Closure oracle.** `MINI_AGENT_GOAL_ORACLE=laya` with `MINI_AGENT_GOAL_ORACLE_URL` points the
  closure check at a self-hosted classifier. The model judge stays the default and the fallback.
- **Web app.** A silver-metal palette, an Apple-style 18 px shape language, a floating prompt pill,
  compact tool cards, generative UI in the chat, voice-note recorder and player, inline images and
  attachments, AI session titles, a model router with three tiers, usage metering per model, and a
  PWA with cookie login.

### Fixed

- Around fifty fixes from QA rounds E1 to E51, among them: a stale save no longer overwrites a newer
  one, a stopped consumer tears its turn down, a bodiless upload is no longer read as an empty one,
  a remote folder listing is bounded in work as well as in size, and the web server compares origins
  against headers an attacker cannot choose.

### Security

- Per-IP rate limits on the expensive routes, loopback-only CORS with no wildcard on private reads,
  attachment sniffing before storage, and a host guard for the web server.

## 0.41.0 — 2026-10-10

Quality is perfect on the pi benchmark — 10/10 PASS on both sides, on every one of the four complete
runs (40 of 40 checks per side) — and mini's speed is **a tie with pi**: a median of **0.98x** over
four full repetitions of the corpus. An earlier note in this file claimed a 0.69x speed win; that
was one run inside the variance and the repetitions did not support it, so it is corrected here.
Jev arrives as two optional toggles, and a truncated turn can no longer be read as a run's final
answer.

### Measured

- **Round 6: three fresh repetitions of the whole pi benchmark. The 0.69x of round 5 did not
  reproduce, and the honest result is a tie, not a win** (#118). Same corpus and model on both
  sides (`minimax/MiniMax-M3`), sequential, no orchestration. The four complete runs read
  **0.69x, 1.13x, 0.98x and 0.93x** (mini 204.5 / 254.5 / 284.8 / 246.7 s against pi's
  295.3 / 225.1 / 291.0 / 265.7 s): a **median of 0.98x** over all four, 0.98x over the three new
  ones, and a range that straddles 1x. **Quality is the solid part: 10/10 PASS on both sides on
  every run**, 40/40 per side, no failing `verify.sh` in 80 checks.
  - Where the speed actually comes from, measured over the 40 runs: **78–81 % of a run's wall time
    is model time** and the harness itself is ~1–2 s of a ~250 s run (about 1 %). The remaining
    variable is how many turns the model takes and how long it reasons on each one — e.g.
    `t10_crash_report` ranged 12.0–94.2 s across four runs at constant quality. There is no
    harness lever left to close a 0.98x; chasing the single 0.69x run would be optimising a
    report number, not the software.
  - Per task, medians over the four runs, the winners are `t1_wordfreq` 0.65x, `t5_script_csv`
    0.70x, `t6_readme_summary` 0.72x, `t8_js_bug` 0.68x and `t4_refactor` 0.87x; the three worst
    are `t10_crash_report` 1.64x, `t9_pkg_resize` 1.58x and `t7_regex_cli` 1.50x — all variance
    in how the model spends its turns, not a defect in either harness.
  - What the round-5 run *did* establish, and what survives: capping the per-turn output at
    **4096** removed the pathological long reasoning turns without losing correctness. It stays as
    the default. It does not, by itself, make mini beat pi in wall time.
  - Round 5 as first recorded: mini 204.5 s against pi's 295.3 s (0.69x), 8 of 10 tasks, 10/10
    quality on both sides. It is kept in the table above for honesty, labelled as the single run it
    was, and superseded by the four-run median. Full detail, including the variance analysis and
    the note that `overhead_ms` is not a valid "harness costs nothing" field, is in
    `docs/pi-vs-mini-benchmark.md` §9.

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
  - **A truncated turn is never read as the final answer** (#116). It has no `tool_calls` and minimax puts
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

- **Jev (TypeSafe System One) as two independent, optional toggles** (#115, #116).
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


[Showing lines 1-753 of 1801 (50.0KB limit). Use offset=754 to continue.]