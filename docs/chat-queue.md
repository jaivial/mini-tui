# Chat ↔ queue bridge (WA-3)

How a bound WhatsApp conversation hands work to the persistent task graph and
gets outcomes back — without the chat reply path ever waiting on the queue.

## Directives

The session turn's prompt teaches the model three machine-readable final-line
directives. The bridge strips them before the reply is journalled or sent, so
the chat only ever carries conversational text plus the bridge's own notes:

| Directive | Meaning |
|---|---|
| `[[mini-queue: <goal>]]` | create a background task from this request |
| `[[mini-followup: <note>]]` | add/correct an existing task ("se me olvidó esto") |
| `[[mini-status]]` | report the state of queued work |

Directives are proposals only: every decision behind them is deterministic
bridge code, never model discretion.

## Task creation (never blocks the chat)

1. `planReply` runs synchronously in the consumer turn path: it strips the
   directive, appends an immediate acknowledgement (`Apuntado en la cola como
   chat-<seq>…`) and records durable intent in `channel_tasks` (state
   `creating`) in the shared channel DB.
2. After the cursor can advance, the bridge's sweep performs the actual
   `queue put` — goal file (0600 under `~/.local/share/mini-tui/queue-goals`),
   project from the binding, cwd from the session (fallback: the consumer's
   working directory), `--embed-dir` when `MINITUI_QUEUE_EMBED_DIR` is set.
   The sweep re-runs every poll tick and at every reply that creates tasks, so
   a crash between acknowledgement and put is recovered, not lost.
3. The task id is `chat-<inbox seq>`: traceable to the exact message, unique
   per request.

## Outcomes back to the originating thread

A second durable consumer (`queue_event_consumers`, consumer name
`queue-events`) polls `queue events-read` with its own cursor:

- Every delivery intent is journalled in `channel_task_outbox` keyed by the
  event seq (`evt-<seq>`) — dedupe across restarts is the primary key, and a
  non-201 send is never marked sent; text evidence in the thread's recent
  outgoing history closes the uncertainty window (same discipline as the
  reply ledger).
- The cursor advances only past events that were skipped (no chat mapping —
  a queue task not created from chat is NEVER delivered anywhere) or
  delivered; an undelivered tail replays with the cursor parked before it.
- Delivered: `done` (the queue itself only closes with verified closure
  evidence — no plain Submitted), `blocked` (with the task's result reason),
  `interrupted`, `cancelled`, and `goal_updated` notes. `running` chatter is
  not delivered.

## Follow-up routing (deterministic)

For `[[mini-followup: <note>]]` the bridge resolves the target task:

1. **Explicit id wins**: tokens in the note that match real task ids. More
   than one named → ask. A named task whose **project differs from the
   binding's project is refused** in-thread (no cross-task/cross-project
   mixing, ever).
2. **Otherwise candidates** = open (pending/running/blocked/interrupted)
   chat-created tasks of the binding's project, newest first. Exactly one →
   amend. Several → `queue search` vector similarity must put one candidate
   clearly ahead (≥ 0.45 absolute and ≥ 0.05 margin); otherwise the bridge
   asks in-thread with the numbered candidates. **It never amends on
   similarity alone** — without embeddings or without a margin it asks.
3. **Apply** is always `queue amend --id <task> --goal-version <v>`: a stale
   version is refused honestly, not guessed.

## Running tasks: fenced interrupt + reconcile

`amend` on a running task makes the queue itself fence it (interrupted,
fence+1); the runner detects the revoked lease/goal version and stops the
worker, reporting `blocked` ("queue worker cancelled"). Only after that
worker-stopped event does the bridge `queue retry --id` (back to `pending`,
picked up by the next lane wave). If the worker has not confirmed stop within
`MINITUI_QUEUE_RECONCILE_TIMEOUT_S` (default 180), the bridge says so in the
thread and does NOT relaunch — operator action required.

## Audit trail

Every routed action logs one structured `channel.queue.audit` line with
`action`, inbox `seq`, `session`, `project`, `thread`, `task` and, where
applicable, the queue worker `owner`/version — enough to reconstruct what was
routed where and why.

## Lane and configuration

`mini-queue-lane.service` runs `mini-agent-rs queue run --owner wa-chat-lane`
under a 25 % CPU / 2 GB cgroup — queue work is heavy-lane work and never runs
against a benchmark measurement. The queue binary must be built with
`--features task-graph`; the consumer takes it via `MINITUI_QUEUE_BIN`
(default: the resolved Rust agent binary, which may not carry the feature).

| Env (consumer) | Meaning |
|---|---|
| `MINITUI_QUEUE_BIN` | queue binary with the task-graph feature |
| `MINITUI_QUEUE_EMBED_DIR` | MiniLM directory; unset → tasks without vectors |
| `MINITUI_QUEUE_POLL_MS` | event poll interval (default 5000) |
| `MINITUI_QUEUE_RECONCILE_TIMEOUT_S` | interrupted-worker wait before retry (default 180) |
