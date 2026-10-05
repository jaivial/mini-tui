# Resource-aware fan-out (the OOM safe net)

`agent-rs/src/resources.rs` and the gate in `subagents.rs` make an orchestrated session fit the
subagents it starts into the box's free room, instead of hoping they fit.

## The calculation

```
max_fanout = min( (MemAvailable - reserve) / per-subagent,   CPU headroom,   cap - live )
```

| term | meaning | default |
|---|---|---|
| `reserve` | memory the session keeps out of the budget | **10 GiB** (`MINI_AGENT_RESERVE_MEM_MB`) |
| `per-subagent` | **measured** average RSS of the running children (rolling mean over samples of each child's whole process group); 256 MiB floor until one is measured | `MINI_AGENT_CHILD_MEM_MB` |
| CPU headroom | binds only when the 1-min load is at/above the usable CPUs (subagents mostly wait on the model); past saturation the room shrinks to nothing at 1.5x | `0.5` core per child |
| `cap` | the hard ceiling of live children | **100** (`MINI_AGENT_MAX_SUBAGENTS`, clamped) |

## Where the AI gets it before fanning out

```bash
mini-agent-rs agent resources          # human: the numbers, then "max fan-out now: N"
mini-agent-rs agent resources --json   # machine: max_fanout, by_memory, by_cpu, per_child_mb...
mini-agent-rs agent can-spawn 30       # "room for 30 more" or how many do fit
```

## Where it is enforced

Every `spawn` recomputes `max_fanout` and refuses a child that would not fit, with the numbers and
exit 1:

```
refusing subagent: 12 are alive and the box has room for 0 more.
  memory 9.8 GiB free, the session keeps 10.0 GiB for itself, a subagent costs 1.2 GiB on average.
  `agent resources` shows the numbers; `agent stop` one that is done, then spawn again.
```

**Only that child fails.** The session, the other children and the app keep running: no OOM, no
crash. As children finish, the room reappears and the rest of a batch starts.

`orch` (the `$orchestration` skill) reads and enforces the same numbers, both detached
(`orch resources`, `orch can-spawn N`, `orch start` refusing a run that would not fit) and forwarded
to the session's hub.

## Sampling

The hub's monitor samples every other tick (`MINI_AGENT_MONITOR_MS`, 250 ms by default), two small
`/proc` reads per live child: the resident set of the child's process group and its CPU time. There
is no new dependency and nothing shells out; a session with no subagent costs nothing.

## Tests

- `src/resources.rs` unit tests: the arithmetic (reserve, cap, load, pressure, averages).
- `tests/resources_gate.rs` end to end: a real spawn refused by a `MINI_AGENT_RESERVE_MEM_MB` above
  the box's free memory, and a session that survives refusals.
- the whole `tests/subagents.rs` loop keeps passing (the gate admits what fits).
