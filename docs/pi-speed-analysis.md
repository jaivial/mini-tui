# pi vs mini: harness speed analysis (2026-10-09)

Comparative, measurement-first analysis of why the [pi coding agent](https://github.com/badlogic/pi-mono)
(local checkout: `~/pi-mono`) finishes coding tasks in a given wall-clock time and why mini-tui's
Rust backend (`agent-rs/`, a port of mini-swe-agent) is faster or slower on the same shape of work.

**Source of truth for every number in this document is the shared findings file
(`findings.md`, run context).** It was derived from real runs, not from reading code; the
source study below explains *mechanisms*, and only spot-checks were done in the repos.
Everything marked **(measured)** comes from that file. Everything marked **(source)** is a code
reading with a file/line reference.

---

## 1. Goal & method

**Goal.** Split coding-task wall-clock time into (a) model time, (b) harness overhead,
(c) idle/retry time, and (d) structural differences in how each harness turns a model reply
into the next model call. Then rank what is actually worth changing in `agent-rs`.

**What was measured (mini, real runs):**

| Corpus | Where | Size |
| --- | --- | --- |
| Interactive runs | `~/.config/mini-tui/runs` | 12 recent `traj.jsonl`, 4783 model calls |
| Headless orchestration runs | `~/.config/mini-tui/orchestration/*/runs/*/traj.jsonl` | 28 runs, 4088 model calls |

Overhead per step is computed from the trajectory as `gap_between_calls - thinking_seconds`,
where `thinking_seconds` is what `agent-rs` itself stamps on each assistant message
(`agent-rs/src/agent.rs`, `query()`). One measurement this method cannot make: per-command
execution duration inside a multi-action step, because the tool messages' timestamps are
stamped after the whole batch renders (`shapes.rs observation_extra`) — any overlap saving
must be argued structurally, not from the journal. Gaps above 60 s are attributed to the
human/operator, not to the harness: the median overhead is 0.03 s, so a 60 s cut is a clean
separation between
"the loop was slow" and "nobody was looking".

**What was studied (pi, source only — no pi runs were recorded for this analysis):**
`packages/agent/src/agent-loop.ts` (the loop), `packages/coding-agent/src/core/agent-session.ts`
(context management, compaction, retries), `packages/coding-agent/src/core/tools/*` (tools),
`packages/ai/src/utils/provider-retry.ts` and `packages/ai/src/utils/retry.ts` (retry policy),
`packages/coding-agent/src/core/cache-warmer.ts` (prompt-cache warming).

**Method caveat.** pi is compared structurally, not by wall clock. The measured numbers are all
mini's; claims about pi are about code paths that plausibly save or cost time, and are labelled.

---

## 2. pi harness study

### 2.1 Main loop — `packages/agent/src/agent-loop.ts`

One model call per *turn*; a turn is `stream → tool batch → stream → …`:

- `runLoop` (line 163): outer `while(true)` keeps the agent alive across queued follow-ups;
  inner `while (hasMoreToolCalls || pendingMessages.length > 0)` runs one model call plus its
  tool batch per iteration. Per iteration it re-enters `config.prepareRequest` (line ~230) so the
  caller can swap model/context *between* calls, and `config.getSteeringMessages()` so a user
  keystroke lands in the current turn rather than after it.
- `streamAssistantResponse` (line 381): applies `config.transformContext` → `convertToLlm` →
  stream, mutating `context.messages` in place and pushing `message_update` events per delta.
  The partial assistant message is pushed into the context at `start` and replaced in place at
  `done`, so no copy of the context is made per turn.
- Truncated output is handled explicitly: `stopReason === "length"` fails every tool call of that
  message up front (`failToolCallsFromTruncatedMessage`, line 478) instead of executing
  half-written arguments — one saved round trip per truncation.

### 2.2 Tool execution — parallel by default

`executeToolCalls` (line 508) picks a mode: sequential only when the caller asked for it
(`config.toolExecution === "sequential"`) **or** when any tool in the batch declares
`executionMode: "sequential"` (line 517). Otherwise `executeToolCallsParallel` (line 586) runs:

- all non-immediate calls are queued as thunks and awaited together with
  `Promise.all(finalizedCalls.map(...))` at line 646;
- results are re-ordered into call order afterwards, so the observation messages sent to the
  model are identical in content *and* order to the sequential path;
- file mutations are made safe by `tools/file-mutation-queue.ts`, which serialises operations
  that touch the same real path (after `realpath`) while leaving different paths concurrent.

This is the single biggest structural difference. pi never pays for two independent commands
serially unless the model wrote them into a `sequential` tool.

### 2.3 Tools — many, small, self-truncating

`packages/coding-agent/src/core/tools/`: `bash`, `read`, `write`, `edit`, `edit-diff`, `grep`,
`find`, `ls`, `powershell`, plus shared `truncate.ts` / `output-accumulator.ts`.

- `tools/truncate.ts:11-13`: `DEFAULT_MAX_LINES = 2000`, `DEFAULT_MAX_BYTES = 50 * 1024`;
  `GREP_MAX_LINE_LENGTH = 500` chars per match line. Truncation is head-or-tail per tool and
  never returns a partial line.
- `tools/read.ts:96`: `read` advertises the truncation limit *in its own description* and offers
  `offset`/`limit`, so the model paginates instead of re-reading.
- `tools/bash.ts:255` / `tools/ls.ts:62` / `tools/grep.ts:78`: every tool's description states
  its output budget; `bash` writes full output to a temp file (`full_output_path`) when it
  truncates, so nothing is lost — it is just not paid for in the prompt.
- `tools/bash.ts:25-37`: explicit per-call timeout, no default, hard ceiling
  `MAX_TIMEOUT_SECONDS`.
- Consequence: precise edits (`edit`, `edit-diff`) replace only the changed lines, and `grep`
  returns 500-char windows — the context that reaches the model is small and stable, which is
  also what keeps prompt-cache keys cheap.

### 2.4 Context management & compaction — `agent-session.ts` + `core/compaction/`

- `transformContext` is installed twice (`agent-session.ts:1768`, `:1789`) and is applied inside
  `streamAssistantResponse` on every call; it is a pure `AgentMessage[] → AgentMessage[]` hook.
- The session does not send `agent.state.messages` raw. `_installAgentRequestProjection`
  (line 787) wraps `agent.prepareRequest` so each request is built from
  `sessionManager.buildSessionProjection().messages` — a projection of the *persisted* session,
  not of the in-memory list. That is where recovery/omission edits (`_omitRecoveryAttempt`,
  line 1237) and branch edits become invisible to the model without rewriting history.
- Compaction is threshold-driven *before* the next assistant response:
  `_exceedsCompactionThreshold` (line 767) → `_compactBeforeNextAssistantResponse` (line 776),
  using `shouldCompact(contextTokens, contextWindow, settings)` at
  `core/compaction/compaction.ts:267`, i.e. `contextTokens > contextWindow - reserveTokens`.
  Tokens are estimated by the chars/4 heuristic (`estimateTokens`, line 298) with a 4800-char
  flat cost per image — no extra model call is needed to decide.
- Overflow is caught in `prepareRequest` as well, so an aborted/oversized response still lands in
  the same compaction path. Manual `/compact` (line 2764) and the automatic path share the same
  `compact()` primitive, which is aborted through its own `AbortController`.

### 2.5 Streaming and prompt cache

- Streaming is always on (`streamAssistantResponse`), and the first token arrives while the tool
  batch of the previous turn is already committed; there is no buffering pass in the loop.
- `core/cache-warmer.ts` keeps cache entries alive: `getCacheWarmingDelayMs` (line 29) refreshes
  at `min(0.9 × TTL, TTL − 10 s)`; `getPromptCacheTtlMs` (line 39) reads the model's
  `promptCache` tier; `isReplayable` (line 55) refuses to replay Anthropic budget-thinking
  requests, where a replay would change the cache key. Warming only fires when the expected
  saving is ≥ $0.05 (`CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS`, line 20), and idle warming is
  discounted by a measured `IDLE_CONTINUATION_PROBABILITY = 0.15` (line 26).
- `core/timings.ts` + `PI_TIMING=1` gives startup/turn timings out of the box.

### 2.6 Retries — `packages/ai/src/utils/provider-retry.ts`

Two layers:

1. **Provider layer**, `retryProviderRequest` (line 107), wrapped around every SDK call
   (`anthropic-messages.ts:649`, `azure-openai-responses.ts:86`, `google-shared.ts`,
   `classifier-shared.ts:74`; the SDKs themselves are called with `maxRetries: 0`).
   Delay comes from `getRetryDelayMs` (line 53), **in this order**:
   1. `retry-after-ms` header, honoured verbatim;
   2. `retry-after` header (seconds, or an HTTP-date);
   3. else `min(0.5 × 2^retryIndex, 8) s`, jittered ×(1 − 0.25·rand).
   A server-requested delay above `maxRetryDelayMs` (default 60 s, line 1) **throws** instead of
   sleeping. Retryability (line 15) honours `x-should-retry`, then 408/409/429/5xx, and treats
   a status-less error as retryable. The sleep is abortable (`abortableSleep`, line 77).
2. **Agent layer**, `RetryPolicy` in `packages/ai/src/utils/retry.ts:116` + the loop in
   `agent-session.ts` (`_retryAttempt`, `auto_retry_start`/`auto_retry_end` events at line 221):
   `maxRetries: 3`, `baseDelayMs: 2000`, `maxAgentDelayMs: 60 000`
   (`core/settings-defaults.ts:17-25`), delay `baseDelayMs × 2^(attempt−1)` capped.

Practical effect: a 429 carrying `retry-after-ms: 400` retries in **0.4 s**. The first retry is
**≤ 0.5 s** even with no header.

### 2.7 Model calls per task

pi has no step limit in the loop; a run ends when the model stops emitting tool calls (or a
tool/`finishTurn` asks to terminate, `shouldTerminateToolBatch`, line 690). Its per-task call
count is therefore *model-driven*, not harness-driven, and no pi runs were measured here. The
comparable mini number is a median of **200 steps/task, hitting the step limit
(`LimitsExceeded`)** (measured) — see §5.3.

---

## 3. mini (`agent-rs`) study

### 3.1 Loop — `src/agent.rs`

- `run` (line 411): builds the initial system+instance messages from templates, then loops
  `step()` until an `exit` role message appears or a limit fires. `save(false)` is called on
  every iteration (line 473) and again after each terminal branch.
- `step` (line 493): `query()` → check `extra.submission` → `execute_actions()`.
- `query` (line 501): applies control commands, checks `step_limit` / `cost_limit` /
  `wall_time_limit_seconds`, then `query_model()`.
- `model_query` (line 523): streams into the journal file (`traj.jsonl`) every
  `MSWEA_PARTIAL_INTERVAL` (0.2 s) — the streaming equivalent of pi's `message_update`, but
  written to disk rather than pushed to a UI bus.
- `query_model` (line 548): `maybe_compact()` → `context_messages()` → model call; on context
  overflow it learns the window (`cmp::learn_window`), compacts, shrinks and retries **once**.
- `execute_actions` (line 585): `for action in &actions { self.env.execute(&command) }` —
  **strictly serial**. All outputs are collected first and then turned into observation
  messages by `model.format_observation_messages`, so the *messages* are well-defined per step,
  but the *executions* never overlap. (A journal-derived "how much would overlap save" number
  is **not** measurable: multi-action tool messages get one timestamp after the whole batch,
  so per-command durations are not in the transcript.)

### 3.2 HTTP + retry — `src/models/http.rs`

`with_retry` (line 347):

- attempts: `MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT` (default **10**);
- wait: `retry_wait` (line 394) = `2^(attempt−1)` clamped to `[MINI_AGENT_RETRY_MIN_WAIT, 60]`,
  default floor **4 s**, i.e. **4, 4, 4, 8, 16, 32, 60 s** — a faithful port of tenacity's
  `wait_exponential(multiplier=1, min=4, max=60)`;
- jitter ×(0.5..1.5) (line 364) — the same idea as pi's, and it exists for a measured reason
  (32 parallel calls retried in lockstep and re-hit the concurrency limit every time);
- connect-refused has its own cheap schedule (`refused_wait`, line 384: 0 s, then capped at 2 s);
- the sleep is interruptible (`agent::interruptible_sleep`).

**The policy never reads `Retry-After` / `retry-after-ms`** — there is no header access at all in
`ModelError`. A 429 that the provider answers with "retry in 300 ms" costs mini at least 4 s
(jittered 2–6 s). Measured cost: **73 retries, 392 s of pure waiting across 28 headless runs**
(measured), with waits observed at 4.0/4.0/4.0/8.0 s.

### 3.3 Environment — `src/environment.rs`

`LocalEnvironment::execute` (line 268) builds the env map, resolves cwd, and runs
`/bin/sh -c <command>` with a timeout (default 30 s) per call; `DockerEnvironment` (line 302) is
the same over `docker exec`. One `execute()` = one process = one action, and `execute_actions`
calls it in a `for` loop. There is no batching primitive and no `&&`-joins of independent
commands, so the harness cannot overlap work the model asked for in one step.

### 3.4 Compaction — `src/compaction.rs` + `agent.rs`

- Trigger: `maybe_compact` (agent.rs:668) estimates tokens as `messages_chars × tokens_per_char`
  and compacts when the estimate reaches `compaction_trigger()`. `tokens_per_char` (line 635) is
  calibrated from the last real usage (`extra.context_chars` / `prompt_tokens`) — a better
  estimator than pi's fixed chars/4, at the cost of one extra full pass over the view per call.
- Cut: `head_length` (compaction.rs:145) protects the head, `tail_start` (line 157) picks the
  tail, `shrink` (line 191) elides the middle; `render_compaction` (line 246) builds the summary
  message. `tail_never_starts_on_tool` is enforced so the model never sees a dangling tool call.
- Overflow is detected by `is_context_overflow` (line 114) on the error kind, with a learned
  per-model window (`learn_window`, line 119) persisted across runs.
- 17 compactions in 28 headless runs (measured). Each one is an extra model call, and the first
  model call of a run costs 1.3–5.7 s (measured) because it is not cached.

### 3.5 Templates — `agent/src/minisweagent/config/mini.yaml`

One tool (`bash`), a single `system_template` + `instance_template`, and an
`observation_template` that passes output through verbatim below 10 000 chars and otherwise
sends `output_head` + `output_tail` (5000 + 5000) with `elided_chars`. `step_limit: 0`,
`cost_limit: 3.0`, `mode: confirm`. The template *is* the tool surface: everything mini can do is
a shell command, which is why its outputs are already small (median 872 chars, p99 11 k, max
37 k — measured) and why there is no `read`/`edit` layer to keep them smaller.

### 3.6 Journal / export — `agent.rs save()` and `append_journal()`

- `serialize` (line 764) builds the full trajectory document: `info` + **all messages** + model
  and environment `serialize()`.
- `save` (line 791) calls `serialize()` on **every** step and appends the new lines to the
  journal (`append_journal`, line 811) plus throttles the full JSON export to every
  `max(20, len/10)` messages or 60 s. The journal only needs `info` and the *new* messages, but
  `serialize()` clones the entire message vector each step — O(n²) total for an n-step run, and
  n is ~150–200 here. Measured as ~27 ms/step of avoidable work (findings, item 3).
- `append_journal` already does the right thing incrementally (only unjournaled messages); the
  cost is entirely in the `serialize()` clone feeding it.

---

## 4. Measured comparison

All rows are from real mini runs (findings.md). pi rows are code-derived and marked.

| Metric | mini (interactive, 12 runs) | mini (headless orch, 28 runs) | pi (source study) |
| --- | --- | --- | --- |
| Model calls | 4783 | 4088 | not measured |
| Wall time | 135 023 s of gaps | 23 397 s | not measured |
| Model time (thinking) | 33 342 s | 19 393 s = **83 % of wall** | n/a |
| Harness overhead, median | **0.03 s**/step | **0.027 s**/step | streaming, no per-turn copy |
| Harness overhead, p99 | — | **0.09 s**/step | n/a |
| Overhead > 60 s (idle/user) | 101 032 s of 101 729 s | — | n/a |
| Prompt cache hit | — | **99.0 %** (51 M/51 M tokens) | warmed (cache-warmer.ts) |
| Actions per step | mean 1.14; 86 % = 1, 14 % = 2 | same | parallel by default |
| Multi-action steps | 580 (14 % of steps, all 2-action) | serial execution; overlap saves unmeasurable (timestamps are post-batch) | parallel by default (`Promise.all`) |
| Tool output size | median 872 chars, p99 11 k, max 37 k | same | capped 2000 lines / 50 KB |
| Retries | — | 73, **392 s** waiting | header-first, first retry ≤ 0.5 s |
| Compactions | — | 17 / 28 runs | threshold, before next call |
| First model call of run | — | 1.3–5.7 s | warmed |
| Steps per task | median **200 (step limit)**, mean 147 | same | no step limit |

Reading the table: **83 % of headless wall time is the model.** The harness's own cost is
~15–30 ms per step, which over a 200-step task is ~4–6 s, i.e. ~0.03 % of a 23 397 s corpus.
Interactive time is dominated by the human, not by either harness.

---

## 5. Where mini loses time (ranked)

1. **Retry policy shape — ~392 s per 28 runs, all of it avoidable** (measured).
   `with_retry` (`http.rs:347`) waits ≥ 4 s on the first attempt and never reads
   `Retry-After`, where pi waits what the server asked (`retry-after-ms`) or at most
   `min(0.5 × 2^i, 8) s` (`provider-retry.ts:53`). Observed waits were 4.0/4.0/4.0/8.0 s.
   Expected saving if the pi shape is adopted: 392 s → ~70 s across the same 28 runs
   (~11 s/run), i.e. ~0.5 % of wall time on this corpus and far more on a provider that uses
   short `retry-after-ms` values.
2. **Steps per task is at the limit, not at the finish line** (measured: median 200 =
   `step_limit` behaviour, `LimitsExceeded` exit). This is the only item that scales with the
   whole task rather than with a rare event: a task that stops 10 steps earlier saves its own
   model time at ~96 s/call mean. Nothing in the harness causes it, but it bounds how much any
   harness fix can matter — which is why the ranking below is about *not* adding calls
   (compaction, retries) rather than about shaving microseconds.
3. **Per-step `serialize()` clone — ~27 ms/step, O(n²) overall** (findings item 3;
   `agent.rs:791` → `serialize()` at `:764`). Over a 200-step task this is ~5.4 s of CPU in the
   loop's critical path. Not the bottleneck today, but it is the only overhead that grows with
   the trajectory, and it is a pure waste: the journal consumes `info` plus the new messages.
4. **Serial action execution — unmeasurable from the journal, but structurally absent.**
   580 multi-action steps exist (14 % of steps), and mini's `execute_actions`
   (`agent.rs:585`) is a `for` loop, so two commands the model issued together always cost
   the *sum*. An earlier draft claimed "0 s savable" from a serial-vs-parallel floor
   comparison; that was wrong: the tool messages' timestamps are stamped after the batch
   (`shapes.rs observation_extra`), so the journal cannot tell how much of a step was
   execution and how much was rendering. Cheap commands make the win small, but pi's
   default is parallel (`Promise.all`) and the harness should not be the reason a paired
   `cargo build` costs 2× 21 s.
5. **Compaction and cold starts** — 17 compactions / 28 runs, plus a 1.3–5.7 s first call
   (measured). Both are real model calls; mini has no cache warmer to keep the entry alive
   across a long gap.

What mini does **not** lose time on, despite looking expensive: prompt caching (99.0 % hit,
measured), output size (median 872 chars), and streaming (already on, `model_query` at
`agent.rs:523`).

---

## 6. Where pi loses time / what mini already does better

- **pi retries a status-less error by default** (`isRetryableProviderError`,
  `provider-retry.ts:25`: `error.status === undefined → retryable`) and throws away a whole
  retry when the server asks for more than 60 s (`validateServerRetryDelayMs`, line 39) where
  mini sleeps, jitters and tries again up to 10 times. On a flaky gateway mini is the more
  patient harness.
- **pi pays for a projection per request.** `_installAgentRequestProjection`
  (`agent-session.ts:787`) rebuilds the message list from the session manager on every call, and
  `transformContext` runs on every call. mini builds one `Vec<&Value>` of indices
  (`context_indices`, `agent.rs:618`) and clones it — cheaper per call, though it pays for it in
  the O(n²) `serialize()` instead.
- **pi's compaction estimate is a flat chars/4** (`compaction.ts:298`) with a 4800-char image
  constant. mini calibrates `tokens_per_char` from actual usage (`agent.rs:635`), so it compacts
  neither too early (wasting a model call) nor too late (wasting an overflow retry).
- **pi's warming is a cost centre when idle** — `cache-warmer.ts` keeps replaying requests while
  the user reads, discounted by a measured 0.15 continuation probability and a $0.05 floor.
  mini needs none of it while its hit rate is 99.0 % (measured).
- **pi's per-task call count is unbounded.** With no step limit and 8 fine-grained tools, a task
  can take many more calls than mini's one-tool loop; mini's median 200 steps *is* its limit,
  which is a different failure but a cheap one.

Net: pi's advantage is not a faster loop — it is that it needs fewer serial seconds per unit of
work (parallel tools, precise edits, header-honouring retries), and mini's advantage is that its
per-call bookkeeping is thinner and its token accounting is measured rather than guessed.

---

## 7. Prioritized optimization plan

| # | Change | Where | Expected saving | Quality risk |
| --- | --- | --- | --- | --- |
| 1 | **Honour `Retry-After` / `retry-after-ms`; pi-shaped backoff** — parse the headers on 429/5xx/transport errors and use `min(0.5 × 2^i, 8) s` jittered otherwise, keeping the floor at 0 for the first attempt and `MINI_AGENT_RETRY_MIN_WAIT` as an opt-in ceiling for one-shot callers | `agent-rs/src/models/http.rs:347` (`with_retry`), `:394` (`retry_wait`) | ~392 s → ~70 s over 28 runs (~0.5 % wall; much more on providers that send short `retry-after-ms`) | **None.** Pure wait-time; same attempts, same abort semantics |
| 2 | **Run a step's independent actions overlapped** — spawn the step's commands up to `MINI_AGENT_PARALLEL_ACTIONS` at a time (default 2), wait them in input order, and keep feeding `format_observation_messages` in the original order so the observation messages are byte-identical | `agent-rs/src/agent.rs:585` (`execute_actions`), `src/environment.rs` (`execute_batch`) | Unmeasurable from the journal (tool timestamps are post-batch), but structurally real: two commands issued together cost the slower of the two, not the sum. Bounded: never more wall time than the serial sum | **Low, if order is preserved**; `Outcome::Submitted`/`Stopped` short-circuit semantics kept, prompt tells the model to batch only independent commands |
| 3 | **Stop cloning all messages per step for the journal** — build the journal from `info` + the unjournaled tail (which `append_journal` already handles) and serialize the full document only on the throttled export / at exit | `agent-rs/src/agent.rs:791` (`save`), `:764` (`serialize`) | ~27 ms/step, ~5.4 s per 200-step task; removes the O(n²) term | **None.** Output stays identical; only the intermediate allocation disappears |

**Structural items justified by the source study, in order of expected value:**

| # | Change | Justification | Expected saving | Quality risk |
| --- | --- | --- | --- | --- |
| 4 | **Read-only tools that do not shell out** (at minimum a non-`sh` file reader with `offset`/`limit` and a 50 KB cap, mirroring `tools/read.ts`) | Every read today costs a shell spawn *and* a `cat` in the prompt; pi's `read` paginates and states its budget in its own description (`read.ts:96`) | Small per call (ms), but each avoided call also avoids a 96 s mean model step when it prevents a formatting error | **Medium** — a new tool changes the prompt; keep `bash` as the only mutating path |
| 5 | **Cache warmer** like `cache-warmer.ts:24-45` (refresh at 0.9 × TTL, ≥ 10 s margin, $ floor) | mini has none; first call of a run costs 1.3–5.7 s and 17 compactions/28 runs each pay an uncached call | Up to a few seconds per cold start | **Low** — it only replays requests, never invents turns |
| 6 | **PI_TIMING-style step timing** (`core/timings.ts:6`) — stamp per-phase durations into `extra` | All of the above is only verifiable if the trajectory records where the ~15–30 ms goes | none directly | **None** |

**Explicitly not worth doing (measured):** prompt-cache tuning (99.0 % hit already), streaming
(already on), template/prompt rewrites (quality risk for ~0 s), and changing
`parallel_tool_calls` defaults for `opencode-go` (provider-specific; findings item 4).

---

## 8. TL;DR

mini's harness costs ~15–30 ms per step and pi's costs about the same; neither is why a coding
task takes as long as it does. **83 % of mini's headless wall time is model time**, and the
largest non-model cost that mini controls is *waiting it invented itself*: a retry floor of 4 s
that ignores `Retry-After` (~392 s over 28 runs). pi's real edge is structural — parallel tool
execution, fine-grained self-truncating tools, header-first retries — and the first three
optimizations for `agent-rs` are correspondingly unglamorous: fix the retry clock, make action
execution concurrency-ready, and stop cloning the whole trajectory every step.

**Status: items 1–3 of the plan are implemented** on branch `perf/pi-speed-parity`
(`Retry-After`/`retry-after-ms` honoured first with pi's throttle backoff, overlapped
`execute_batch` with serial-equivalent semantics, `serialize_info` for the journal-only save
path, one journal file handle per model call, and a prompt nudge to batch independent
commands), verified with `cargo build --release` and a `$review-code` pass. Item 4+ (read-only
tools, cache warmer, per-phase timings) remain open.
