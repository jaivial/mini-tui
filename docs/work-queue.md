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

## API

UI (same-origin): `GET /api/queue`, `POST /api/queue/prompt {prompt, model?, attachments?}`,
`POST /api/queue/new`, `POST /api/queue/tasks/:id/cancel`, `POST /api/queue/tasks/:id/redirect {message}`.
Queue changes are pushed on `/api/stream` as `{type: "queue", tasks, main, concurrency}`.

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
