# Delegation A/B: mini-direct vs mini-orch fan-out on a decomposable corpus

Date: 2026-10-21. Corpus: `benchmark/pi-vs-mini/parallel` — parts share nothing (each part
reads its own seeded 12k-line log, writes its own report JSON): `tp1_single` (N=1 control),
`tp2_pair` (N=2), `tp4_quad` (N=4). Both arms on the `/anthropic` surface, MiMo V2.6 Flash,
one repetition. Direct arm: `MINI_AGENT_DEPTH=1` (one agent, serial). Orch arm: top-level web
session (router arms the orchestrator lane), `agent_delegate` fan-out. Runs
`20261021-193245` (direct) and `20261021-193535` (orch). 6/6 PASS on both arms.

## Results

| task | mini-direct | mini-orch | S end-to-end |
|---|---|---|---|
| tp1_single (N=1) | 36.5 s | 413.0 s | **0.09x** |
| tp2_pair (N=2) | 70.1 s | 574.7 s | **0.12x** |
| tp4_quad (N=4) | 60.1 s | 248.4 s | **0.24x** |

## Anatomy (from the trajectories)

**The wave itself works.** tp4: four report workers spawned in one delegation step ran mostly
overlapped — worker windows 56.6/85.1/85.3/56.5 s, union 175.1 s, ≈1.95x parallelism; each
worker's own analysis took 6-7 turns. Amdahl's s from the launch side is not the problem.

**What ate the wave:**

1. **Worker ceremony is 5-10x the work.** The tp2 pay-log worker finished the actual analysis
   in 6 turns (turn 12 of its trajectory says "Done"), then spent ~39 more turns on harness
   ceremony: `mini-tui tasks set` failing (returncode 127 — the CLI does not exist in a
   worker's PATH), `agent contract-check` 5/6 blocked by a stale coverage snapshot, handshake
   regeneration, and repeated parent wakes each demanding fresh evidence. 52 messages for a
   6-turn job. The direct arm does the same subtask in ~10 messages.
2. **The parent adds workers the task never asked for.** tp4: after the four report workers,
   the parent spawned a fifth, `final-verify` (25 messages, 101.6 s of model time, ending at
   +175 s) — over-verification the direct arm never does.
3. **Router misfire on markdown bullets.** tp1 (unitary) was delegated anyway and cost 413 s
   vs 36.5 s: the task's bullet list enumerated the report's JSON keys, and `decomposable()`
   counted bare `- ` bullets as work items. Fixed in this same commit: only numbered lists
   (>=2 items) or explicit parallel/separately/subtasks vocabulary claim a split.
4. **Collection is per-worker.** Each completion wakes the parent for a full turn (kanban
   bookkeeping per card, P2-D3's grouped collection not yet implemented).

## Where this leaves goal B (delegación ≈Nx)

End-to-end S is 0.09-0.24x today: the fan-out machinery parallelizes, but the per-worker and
per-completion ceremony dominates any real subtask of this size. The measured budget says the
motto "N x faster" needs the ceremony removed, not better parallelism:

- worker prompt: no `mini-tui tasks set`, no contract-check/handshake unless the parent
  declared a contract (the measured tp2 worker burned 39 turns there);
- one collection turn per wave (P2-D3), one oracle pass per wave (P2-D5) instead of per worker
  (each worker closure is a judge call + evidence diff today);
- parent prompt: never spawn a verification worker for parts that are self-verifiable
  (tp4's `final-verify` alone cost ~100 s of model time);
- router: bullets fix (this commit) keeps unitary tasks direct.

Order-of-magnitude budget for tp4 from the measured pieces: wave max ~85 s + one collection
turn ~15-30 s ≈ 100-115 s ≈ 2x direct (60.1 s). With workers as lean as the direct arm's per
part (~15 s), the same wave is ~50-70 s ≈ 1x — i.e. ceremony must fall below ~50 s before
N=4 breaks even, and the corpus's parts are too small to ever show 4x; Nx claims need parts
of minutes, not seconds.
