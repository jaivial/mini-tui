# Persistent task graph and multi-project queue

Build `mini-agent-rs` with `--features task-graph` to enable `queue`. Default builds keep the embedding/database dependencies out of the fast runner.

The database stores tasks, project working directories, dependency edges, results and normalized 384-dimensional MiniLM vectors. SQLite WAL and immediate transactions serialize claims across processes. Each claim has an owner, expiry and increasing fence. Stale workers cannot renew or close newer claims. Dependency cycles are rejected. A project, identical directory or overlapping directory tree has at most one running task; separate projects/directories can run in parallel. Expired workers become `interrupted`, not automatically duplicated. Retry requires `--reconciled yes` after checking the previous worker has stopped.

A worker that the runner itself stops is a different case. `SIGTERM` to `queue run` — the signal a `systemctl stop` or `restart` sends, so any deploy — makes the runner kill and reap the worker's process group: the worker is then provably dead, and its card returns to `pending` for the next wave instead of `blocked`. `blocked` threw the work away and demanded a manual `retry --reconciled yes` for what was really "the lane was restarted", which is why the shutdown path now calls `release`. `release` hands a live lease back to the queue, bumps the fence (the dead worker can no longer finish or heartbeat) and clears the result, since an outcome belongs to a worker that actually produced one. Only the current lease owner/fence can release it.

## CLI

```sh
mini-agent-rs queue put --id backend-1 --project backend --cwd /path/to/backend --goal-file /tmp/goal.txt --embed-dir /path/to/minilm
mini-agent-rs queue put --id ui-1 --project frontend --cwd /path/to/frontend --goal-file /tmp/ui-goal.txt --deps backend-1 --embed-dir /path/to/minilm
mini-agent-rs queue graph
mini-agent-rs queue search --query-file /tmp/query.txt --embed-dir /path/to/minilm
MINI_AGENT_QUEUE_MODEL=rosetta/zai-glm/glm-5.3-flash mini-agent-rs queue run --owner queue-worker --limit 2
```

All commands accept `--db PATH`; default is `~/.local/share/mini-tui/task-graph.sqlite` (0600). `put` only edits pending tasks. `run` drains ready waves until no work is ready, then returns the final graph. Run it in a managed background cgroup to keep the conversation free. It does not poll from the conversational agent. It starts ordinary Rust agent processes, which retain the existing nested-subagent capabilities. It is not a UI scheduler integration yet.

Manual worker commands: `claim`, `heartbeat`, `release`, `finish`, `retry`. They require the lease owner/fence where applicable. `finish` accepts `done` or `blocked` and a result file. CLI output is JSON. The built-in runner calls `done` only when its agent exited successfully with `Submitted`, so the closure oracle still gates completion.

## Embeddings and resources

Place the official `sentence-transformers/all-MiniLM-L6-v2` files `model.safetensors`, `config.json` and `tokenizer.json` in the embedding directory. The observed weight file is 90,868,376 bytes. Inference uses Candle on CPU in Rust, one sentence at a time, at most 256 tokens, mean pooling without padding and L2 normalization. It refuses weights over 512 MB or a different model shape. It was manually exercised under a 1900 MB memory cgroup. No Python inference service or ONNX runtime is required.

Exact cosine search scans stored task vectors. This is appropriate for a task registry, not a claim of million-document ANN performance. Graph edges are separate from vectors; both live in the same transactional database. An absent `--embed-dir` stores a task without embeddings, explicitly marked by `embedded:false`.

Source guidance:
- https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/tree/main
- https://github.com/huggingface/candle/issues/380
- https://www.sqlite.org/wal.html

## Current limits

There is no main-conversation/web UI integration or automatic cgroup creation. Run the queue inside the user's managed resource boundary. Interrupted work needs process reconciliation, deliberately. Embeddings are English MiniLM and should not be advertised as strong multilingual retrieval. The queue does not prove official benchmark success or a 2x swarm speedup.
