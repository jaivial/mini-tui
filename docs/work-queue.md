# Work queue: one chat, background tasks

The web app is one screen: a single chat, and the task queue on the right. There is no sessions
sidebar, no panes and no kanban. Everything sent to the chat becomes work in a queue.

## The pieces

| piece | what it is | where |
| --- | --- | --- |
| dispatcher | the chat's agent. It has **no shell and no files**: it turns each request into a better-written task and queues it, or redirects a task in flight. One model call per message. | `agent/src/minisweagent/config/dispatcher.yaml`, `MINI_AGENT_TOOLSET=dispatcher` |
| queue | durable FIFO of tasks with a concurrency cap (Settings → General → Work queue, 1–300, default 300) | `src/web/workQueue.ts` (`queue_tasks` in the sessions DB) |
| worker | one background mini session per task: the normal agent (shell, read/write/edit, browser) plus its card tools | `MINI_AGENT_TOOLSET=worker`, `<queue_worker>` in `mini.yaml` |
| glue | starts workers, feeds results back to the chat, serves the queue API | `src/web/queueHost.ts`, routes in `src/web/serve.ts` |
| panel | tasks by state: working, queued, completed, error; redirect / cancel / open the worker's session | `web/src/lib/components/QueuePanel.svelte` |

## Flow

1. The human writes in the chat. The server appends a `<queue_state>` block for the dispatcher
   only (active tasks with their directory, what finished since its last turn, worker notes, and
   the tasks closest to the new message by similarity). The transcript shows the message as typed.
2. The dispatcher calls `task_create` (several independent parts → one call with `tasks: [...]`)
   or `task_redirect`. Its turn ends with the queue's confirmation: no second model call.
   `@MESSAGE` in a brief is replaced by the human's message verbatim, so the dispatcher does not
   spend output tokens copying a long specification.
3. The queue starts tasks while `running < concurrency`; the rest wait. With concurrency 5 and 8
   tasks: 5 run, 3 wait, and each finished task hands its slot to the oldest waiting one.
4. A worker keeps its card's **description** current (`task_update`; the title is the
   dispatcher's) and can reach the dispatcher mid-task (`task_notify`, shown in the chat).
5. When a worker ends, its task becomes `done` or `error` with the final answer as its result, and
   a one-line notice lands in the chat.

## Models

A task runs on the model the chat had **when the task was created**: changing the chat's model
(the picker, `/model`) applies to the dispatcher and to tasks created from then on; tasks already
launched keep the model they started with.

**Fallback order** (Settings → General → Model fallback order): models in order of preference,
chosen from the connected providers. A worker (or the dispatcher) whose model fails at the
provider — any error the retries could not fix: a dead gateway, auth, quota, 5xx — continues
the same run on the next model in the list, with its whole conversation; the card and the chat say
`continuing on <model>`. The task stops only when every model in the list has failed. With a chain
behind it, a call gives up on a failing provider after ~20 s instead of 2 min
(`MINI_AGENT_MODEL_FALLBACKS` in the agent; credentials come from `providers.json`).

## Asking a worker how it is going

The dispatcher's `task_status` (for a task, or the whole queue) reads the worker's LIVE session:
its last commands and their results, what it is writing right now, model calls and time so far.
"How is t3 going?" / "is it stuck?" is answered from that.

## The browser

The agents share the persistent `cu` daemon. The **Browser** panel (globe button, `/browser`)
lists its tabs and shows the chosen one as a screenshot or as the live stream relayed by the
server (the daemon's token never reaches the page). **Take control** sends the human's taps,
scrolling and typing to that tab.

- A task about how a page LOOKS: the worker takes a `shot` and names the PNG in its result; the
  chat shows the image.
- A page that needs a human (captcha, QR, login, 2FA, consent): the worker calls
  `task_show_browser {tab, message, wait_seconds}`. The chat gets the request, the panel opens
  live on that tab with a **Done** button, and the worker's call returns when the human presses
  it (or the wait runs out). Workers never try to defeat a captcha or guess credentials.

Routes: `GET /api/browser/tabs`, `GET /api/browser/tabs/:id/shot` (PNG),
`WS /api/browser/tabs/:id/live?control=1`, `POST /api/browser/tabs/:id/input` (tap / scroll /
type / press), `POST /api/queue/tasks/:id/browser-done`.

## Folders

Two tasks working in the same folder (or one inside the other) never run at the same time: the
later one waits, and tasks in other folders go past it. Measured: two parallel "rewrite calc.py"
tasks overwrote each other's change until the second redid it. Home, `/tmp` and `/` (where a
task lands when no folder was named) are exempt, or every such task would wait for the others.
The panel and the dispatcher's `<queue_state>` say what a waiting task waits for.

## Relations and redirection

Each task stores the tasks it is related to (TF-IDF cosine over title, description and brief).
The dispatcher sees the closest ones for every new message, and decides:

- a correction or small variation of an **active** task's deliverable → `task_redirect`;
- a follow-up on a finished task's result → `task_redirect` (it re-opens and continues the same
  worker session, so nothing already done is redone);
- anything else, including the same kind of work in another directory → `task_create`.

A `task_create` that duplicates an active task (similarity ≥ 0.72) is refused with that task's id
unless it passes `new_task: true`. Redirect semantics by state: running → the message reaches the
agent before its next step (control file); queued → folded into its brief; finished → re-opened
and queued again on its own session. A prompt that reaches an agent after its last step is not
lost: the run continues with it instead of exiting.

The task nodes and their `RELATED_TO` edges are projected into the graph by
`scripts/orchestration_graph_sync.py` (label `MiniTask`, id `queue:<task>`), where the graph RAG
indexes them with the rest of the sessions.

## Robustness (stress-tested)

`benchmark/stress/mock_llm.py` is a scripted OpenAI-compatible model (no API spend);
`stress_queue.py` runs 20 scenarios against a test server: the concurrency cap under load
(30 tasks at 5, 300 at 300), raising/lowering the cap mid-run, worker failures, cancel (single,
100 at once — every worker process and its commands stop), redirects to running / queued /
finished tasks, redirect bursts and races at random moments of short runs, a redirect followed by
a server restart, restarts mid-run, 10 prompts at once to the chat, malformed and oversized
input, a stopped chat, a worker session deleted by hand, and same-folder serialisation.
`dispatcher_cases.py` checks the dispatcher's decisions with a real model (greeting, multi-part
split, redirect vs new work, status, cancel, prompt injection, literals kept verbatim).

Memory: finished and cancelled worker sessions are released from the server (the task keeps the
result; opening the session or redirecting the task brings it back). Queue pushes are deltas,
with the full list on every stream (re)connect. The panel draws 100 rows at a time.

## API

UI (same-origin; string fields only, anything else is a 400): `GET /api/queue`, `POST /api/queue/prompt {prompt, model?, attachments?}`,
`POST /api/queue/new`, `POST /api/queue/tasks/:id/cancel`, `POST /api/queue/tasks/:id/redirect {message}`.
Queue changes are pushed on `/api/stream` as `{type: "queue", delta: true, tasks, main, concurrency}`
(only the tasks that changed; the stream's first frame is the full list).

Agents (loopback, `x-queue-token` = a per-process secret handed only to agents the server spawned):
`POST /api/queue-agent/tasks`, `/status`, `/tasks/:id/{redirect,cancel,update,notify}`.

## Worker speed defaults

- `MINI_AGENT_THINKING=adaptive`: routine turns go out with thinking disabled; the turn after a real
  failure (a check or edit that failed, a format error, a repeated action) reasons again.
  A look-around command that found nothing (`ls`, `grep` with no match) does not count as a failure.
- No closure judge (`MINI_AGENT_GOAL_ORACLE=off`; `MINITUI_WORKER_JUDGE=1` restores it): the
  worker's own verification is the closure, and the judge doubled short tasks.
- No cache warmer, no subagent tools (the queue is the parallelism).
- The worker starts in the task's directory: the dispatcher's `cwd`, else the first existing
  directory its brief names.

Benchmarks: `benchmark/pi-vs-mini/run_queue_bench.py` (the real flow through the queue, vs pi,
interleaved) and `run_worker_direct.py` (the worker alone, for fast A/B).

## Benchmark: assigned-task execution, mini queue vs pi (24 Oct 2026)

Corpus `benchmark/pi-vs-mini/tasks` (10 tasks, deterministic `verify.sh`), MiMo v2.6 Flash on the
token-plan Anthropic surface for both harnesses, 3 repetitions, mini and pi interleaved task by
task, a fresh queue per round. "worker" = the queue task's start → finish (the assigned task's
execution); "e2e" adds the dispatcher's turn (message sent → task finished).
Runner: `python3 run_queue_bench.py --reps 3`.

Final configuration (`runs/queue-20261024-031939`):

| task | mini worker (s) | mini e2e (s) | pi (s) | pi / mini worker |
| --- | ---: | ---: | ---: | ---: |
| t10_crash_report | 22.5 | 37.1 | 32.4 | 1.44x |
| t1_wordfreq | 13.4 | 18.0 | 19.2 | 1.43x |
| t2_grep_logs | 15.5 | 23.0 | 18.8 | 1.21x |
| t3_pytest_fix | 18.7 | 27.0 | 17.4 | 0.93x |
| t4_refactor | 55.4 | 74.1 | 91.9 | 1.66x |
| t5_script_csv | 15.8 | 19.0 | 36.9 | 2.34x |
| t6_readme_summary | 38.8 | 42.1 | 53.0 | 1.37x |
| t7_regex_cli | 19.0 | 35.1 | 116.4 | 6.13x |
| t8_js_bug | 9.9 | 19.0 | 69.8 | 7.05x |
| t9_pkg_resize | 12.7 | 28.1 | 45.3 | 3.57x |
| **sum of medians** | **221.7** | **322.5** | **501.1** | **2.26x** (e2e 1.55x) |

Pass: mini 30/30, pi 30/30. Against pi's mean over the three comparable rounds (478 s) the worker
ratio is 2.16x.

How the worker got there (same corpus, worker run directly, `run_worker_direct.py`, 3 reps):

| change | sum of medians |
| --- | ---: |
| first queue round (worker in `~` when the brief named no cwd, closure judge on) | ~600 s |
| worker starts in the task's directory, no closure judge | 391 s |
| adaptive thinking (reason only after a real failure) | 253 s |
| look-around misses do not trigger thinking; short result card | 217 s |
| hedged provider calls (duplicate after 12 s of silence) | 232 s (noise) |

The dispatcher went from ~10 s per message (writing a ~460-token brief) to ~5 s: a single task
needs no prompt at all, the human's message is the brief.

Limits: one model, one machine, ten small tasks, three repetitions; provider latency tails
(turns of 100+ s on both sides) dominate the variance, which is why per-round ratios moved
between 1.4x and 2.3x while the worker changes above were landing.
