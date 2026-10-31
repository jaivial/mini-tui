# Rust per-session footprint (2026-10-31)

What one `mini-agent-rs` session costs in memory, threads, processes and wakeups, what was cut,
and what was tried and left out. Model-facing behaviour is unchanged: the same request bytes,
prompts, tool list and timings (see Validation).

## How it is measured

`benchmark/footprint/footprint.py` runs the agent against a local scripted OpenAI-compatible
mock (no network, no API spend) with the environment mini-tui gives a web session, the built-in
`cu` MCP server included. It samples `/proc` every 10 ms and reports medians over runs: peak RSS
and PSS of the agent, peak RSS of its process tree, threads, processes, agent CPU and voluntary /
involuntary context switches (per thread, dead threads included). `--idle S` keeps the session up
after its turn, as a web session waiting for a follow-up, and reads its RSS `S` seconds later.
The developer's `~/.config/mini-swe-agent/.env` is isolated (it can name remote MCP servers).

Scenarios:

- **a12**: 12 bash steps of 2000 lines, a 2 s `sleep`, final answer (5 runs). A typical turn.
- **b60**: 60 steps of 3000 lines, no sleep (3 runs). A long, large conversation.
- **d20**: 2 steps and a 20 s `sleep` (3 runs). A session waiting on a long command.
- **idle60**: b60, then 3 s idle after the turn (3 runs).

The box was loaded (load 17-22 on 16 CPUs, from other work) during all runs: wall times and
CPU are noisy at the 2-5 % level; memory, thread and process counts are not.

## Results

Baseline is `f256c41` built in this worktree. "Final" is the branch head.

| scenario | build | agent RSS MB | agent PSS MB | tree RSS MB | threads | procs | agent CPU s | vol. ctx sw | invol. ctx sw | wall s |
|---|---|---|---|---|---|---|---|---|---|---|
| a12 | baseline | 14.00 | 11.61 | 23.72 | 5 | 4 | 0.07 | 566 | 43 | 6.48 |
| a12 | final | 12.95 | 10.50 | 18.95 | 3 | 3 | 0.06 | 147 | 29 | 6.37 |
| b60 | baseline | 21.79 | 19.48 | 25.64 | 5 | 2 | 0.44 | 790 | 598 | 19.68 |
| b60 | final | 18.75 | 16.20 | 18.75 | 3 | 1 | 0.38 | 693 | 473 | 19.31 |
| d20 | baseline | 12.64 | - | 22.63 | 5 | 4 | 0.06 | 4020 | 33 | 21.35 |
| d20 | final | 12.06 | - | 18.12 | 3 | 3 | 0.02 | 40 | 13 | 21.29 |
| idle60 (RSS 3 s after the turn) | baseline | 21.89 | | | | | | | | |
| idle60 (RSS 3 s after the turn) | final | 14.86 | | | | | | | | |

Per change (the same scenarios, one change toggled or added at a time):

| change | how isolated | effect |
|---|---|---|
| `M_ARENA_MAX=2` | baseline with `MALLOC_ARENA_MAX=2` | a12 agent RSS 14.00 -> 13.77 MB, b60 21.79 -> 21.43 MB |
| lazy `cu` MCP | final with `MINI_AGENT_CU_MCP_LAZY=0` | a12 tree 23.18 -> 18.95 MB, 4 -> 3 procs, 4 -> 3 threads; d20 tree 22.36 -> 18.12 MB |
| fd waits, lazy hub monitor | v2 (allocator + lazy cu + waits) vs baseline | d20 4020 -> 42 voluntary switches, agent CPU 0.06 -> 0.02 s; a12 566 -> 153 |
| request body moved, not cloned | v2 vs final without `malloc_trim` | b60 agent RSS 21.53 -> 18.89 MB, PSS 19.10 -> 16.38 MB |
| `malloc_trim` after turn/compaction/export | final without `malloc_trim` vs final | idle60 18.99 -> 14.86 MB; peaks unchanged (it acts after them) |

TUI/web side (`watchTrajectory`), 20 quiet sessions watched for 20 s in one Bun process:
CPU 47-48 ms -> 27-33 ms, and an appended journal line reaches the snapshot callback in 4-5 ms
instead of 32-40 ms (the old 200 ms poll). No reads happen while nothing changes.

## Changes

1. **Allocator** (`agent-rs/src/mem.rs`): `mallopt(M_ARENA_MAX, 2)` first thing in `main`. Not the
   environment variable, so the commands the agent runs do not inherit it.
2. **Heap trim**: `malloc_trim(0)` at the end of each turn, after a compaction and after a full
   trajectory export. The peak is unchanged; the idle session no longer holds it.
3. **Lazy built-in `cu` MCP** (`agent-rs/src/mcp.rs`): `tools/list` of the built-in server is cached
   in `$XDG_CACHE_HOME/mini-tui/cu-tools-<key>.json` (default `~/.cache/mini-tui`), keyed by the
   program's arguments, environment, path, inode, size and mtime, and for a wrapper script (the
   usual `~/.local/bin/cu`) its text and the stamps of every absolute path it names; 24 h TTL. With
   a valid cache the run exposes the same tools and starts `cu mcp` on the first call. A first call
   that lists something else rewrites the cache for the next run; a start failure removes it so the
   next run starts eagerly. No cache, or an unreadable one: the old eager start, which writes the
   cache. Only the built-in server (`cu`, no id) is affected. `MINI_AGENT_CU_MCP_LAZY=0` disables it.
4. **Fewer wakeups** (`agent.rs`, `environment.rs`, `subagents*.rs`, `main.rs`, `graph_queue.rs`):
   a stop eventfd written by the signal handlers after `STOP` is set; `interruptible_sleep` and the
   command wait block on it (the command wait on a pidfd of the leader as well) instead of polling
   every 20 ms / 5 ms; the output drain waits on a condvar the reader thread signals per chunk and
   at EOF; the hub monitor thread is started by the first child or plan, not by every run. Same
   timeouts and idle windows; `harness_ms` is still measured around the same calls.
5. **TS watcher** (`src/traj/watch.ts`): the run's directory is watched with `fs.watch`
   (non-persistent), events for the journal or the export trigger a read, at most one per
   `intervalMs`; a backstop poll at `max(5 x intervalMs, 1 s)` covers a lost event. If the
   directory cannot be watched (missing, no inotify instance left, watcher error) it polls at
   `intervalMs` as before. `events: false` keeps the old behaviour.
6. **Request path** (`agent-rs/src/models/http.rs`): the chat stream body is moved into the worker
   thread instead of being cloned twice; `post_json` serializes once into an `Arc<String>` shared by
   the worker and every hedged copy.

## Validation

- Request bytes: `benchmark/footprint/wirediff.sh /tmp/mini-agent-rs-wtbase <final>`:
  `cu-cached` 28, `cu-cold` 16, `no-cu` 26, `long` (60 x 3000 lines) 122 request bodies, all
  IDENTICAL byte for byte. `cu-cached`/`cu-cold` call `mcp__cu__status`, so the lazy start and the
  cached tool list are on the wire.
- Parity suite (`agent-rs/tests/parity/run_all.sh`): on `f256c41` itself every scenario already
  reports Python vs Rust differences (the Rust agent has moved on: fast path, cost limit default,
  `confirm_exit`, ...), so it cannot gate this branch as "all IDENTICAL". Its full output, with
  timings, ports and temp paths normalized, is identical between the baseline binary and the final
  one (357 lines, `diff` empty): every scenario differs from Python in exactly the same way.
- `cargo test --release`: unit 153 passed; integration 44 passed, 12 failed, and the same 12 fail
  at the same assertions on `f256c41` (run in a user namespace with a fake `/proc/loadavg`,
  because the CPU guard refuses child spawns on this loaded box).
- `bun test` (full suite): 1823 pass, 35 fail, 4 errors. Every failure is in the main-branch
  baseline list except the two font-file tests (E26, E30), which fail the same way in a clean
  worktree of `f256c41` (the font files are not tracked); the errors are the missing
  `site/node_modules` and late assertions of baseline tests that timed out under load. The new
  watcher tests in `tests/journal.test.ts` pass.
- `bun run typecheck`: the 34 baseline errors in `tests/` plus 15 in `site/` (no
  `site/node_modules` in a worktree); none in `src/` or in the touched files.

## Tried and not adopted

- **mimalloc** (`mimalloc` crate as global allocator): a12 agent RSS 32.3 MB, b60 42.6 MB, versus
  13.0 / 18.8 MB with glibc and the arena cap. It also adds a C dependency. Rejected.
- **`lto = "fat"`, `codegen-units = 1`**: agent RSS -1.0 MB (a12 12.95 -> 11.97, b60 18.75 ->
  17.71), binary 14.6 -> 12.6 MB, but a clean release build takes 150 s instead of 71 s and an
  incremental one 103 s instead of 30 s. Left out of `Cargo.toml` because of the rebuild cost of
  the development loop; it can be used for a deployment build with
  `CARGO_PROFILE_RELEASE_LTO=fat CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 cargo build --release`.
- **`panic = "abort"`**: not tried. A panicking helper thread now ends only that thread (its
  `JoinHandle` or channel reports the failure); with abort it would take the session down, and
  verifying every such path was out of scope.
- **Removing the per-step context clone** (`Agent::context_messages`): `Model::query` takes
  `&[Value]`, so the view must be one contiguous slice; avoiding the copy means changing the trait
  and every backend and caller (wire, deterministic, rlm, shard, clones, goal oracle). The copy
  lives only for the duration of the call, and the trim returns it afterwards; the two larger
  copies after it (the HTTP body clones) are gone. Deferred.
