# Delegation-Nx campaign — eight optimization loops, measured

Date: 2026-10-21/22. Model: MiMo V2.6 Flash over the token-plan `/anthropic`
surface (rolling cache_control). Harness: mini-tui-web (mini-direct =
`MINI_AGENT_DEPTH=1`, mini-orch = router + fan-out waves). Corpora:
`benchmark/pi-vs-mini` (10 tasks) and `parallel/` (tp* seconds-scale parts,
ph* minute-scale homogeneous parts, het* heterogeneous parts, big8 = eight
minutes-scale heterogeneous parts). One to two repetitions per cell; the
per-rep swing on small parts measured up to 2.5x on both arms — totals and
consistent ratios are the signal.

## Goal A — mini-direct faster than pi at equal pass rate

| | total (10 tasks) | PASS | per-task wins |
|---|---|---|---|
| mini-direct (after loops 1-5) | **497.7 s** | 10/10 | 6 of 10 |
| pi (same model, same surface) | 550.9 s | 10/10 | 3, 1 tie |

**Achieved: 1.11x faster at 10/10.** The day before the campaign mini-direct
was 4.3x SLOWER than pi. The lever stack: `/anthropic` surface with rolling
cache_control (2.18x over `/v1`, 86% input served from cache), closure judge
skipped when the workspace ships its own verifier, one-reopen oracle cap with
gap sanitizing, worker/direct prompt discipline (verify-once, close on the
first answer), and the round-5 output cap aligned at 4096.

## Goal B — delegation faster than direct when the work divides (Nx)

S(N) = wall_direct / wall_orchestrator. Medians of 2 reps unless noted.

| corpus | parts | part scale | S measured |
|---|---|---|---|
| tp2/tp4 | 2-4 homogeneous | seconds | 0.2-1.1 (noise; direct amortizes one shared script) |
| het2 | 2 heterogeneous | ~30-60 s | 0.72-0.88 |
| het4 | 4 heterogeneous | ~30-60 s | 0.65-1.13 |
| het8 | 8 heterogeneous | ~15-60 s | **1.05-1.27** |
| **big8** | **8 heterogeneous** | **1-3 min** | **1.62-1.63 (both reps)** |

**Achieved: division wins, consistently 1.6x at N=8 with minutes-scale
parts** — and S grows with N on every corpus where parts do not share a
serial script. The literal "Nx" is Amdahl's ceiling, not a harness feature:
S(N) = 1/(s + (1-s)/N + c(N)) with the measured wave's fixed cost (brief
turn + spawn + one collection turn ≈ 40-70 s) and per-part worker time T, a
wave pays F + T_max while the serial arm amortizes tooling across parts.
Nx is approached as T >> F; at the measured T the fit implies s_eff ≈ 0.55,
ceiling ≈ 1.8x at N→∞ for this part shape. Bigger parts or a smaller F move
the ceiling; nothing moves it to linear.

## The eight loops (all merged, deployed and validated)

| loop | change | measured effect |
|---|---|---|
| 1 | one parent wake per wave (Hub wave_notes), wave workers without their own judge, no session cards or contract-check ceremony in workers, no verification workers | orch wall on tp1/tp2/tp4: 413/575/248 s -> 67/146/98 s |
| 2 | closure judge skipped when the workspace ships its own verifier (MINI_AGENT_GOAL_ORACLE=always to force) | goal-A gap closed: mini-direct 635.5 -> 497.7 s |
| 2b | the router's direct lane renders the worker prompt, not the orchestrator frame (MINI_AGENT_LANE_MODE) | unitary task in orch env: 66.6 -> 30.7 s (direct baseline 26.5) |
| 3 | heavy + heterogeneous corpora (ph*, het*) with self-verifying checkers | the Nx measurement infrastructure |
| 4 | verify-once discipline, close-on-first-answer (fixes a loop-1 regression that taxed every wave worker one FormatError turn), leaner briefs | wave workers: 22-38 -> 5-6 turns |
| 5 | bounded thinking (the gateway honors `thinking.budget_tokens`; unbounded measured at ~40 s/turn), 1024 budget for wave workers, output cap 4096 aligned, no mid-wave pokes | worker turns: 16-40 -> 8-12 s |
| 6 | deterministic fixture regeneration (a stale marker had left het* logs unplaced; both arms hunted the file) | het walls roughly halved, noise down |
| 7 | het8 (N=8) + empty-board kanban gate | first S(8)>1 |
| 8 | big8: minutes-scale parts (12-item reports, triple aggregates, 3 planted bugs per code part) | S(8) = 1.62-1.63, both reps |

## Quality

PASS rates stayed flat across the campaign (goal A 10/10 both arms; the
parallel corpora 23/24 task-runs PASS, the two failures being part-level
answer errors on both arms — one direct, one orchestrator — not systematic).
The P0 protections (pre-existing-file guard, gap sanitizing, one-reopen cap)
kept verifier tampering at zero in every recorded run.

## Reproducing

```
cd benchmark/pi-vs-mini
python3 run_bench.py --mini-only              # 10-task corpus, both mini arms via web
BENCH_TASKS_DIR=$PWD/parallel python3 run_bench.py het8_wave big8_wave --mini-only
python3 run_ab_surface.sh                     # /v1 vs /anthropic endpoint A/B
```
Launchers resolve node/pi from env/PATH; fixtures regenerate automatically.

---

# Update 2026-10-22 — loops 9-14

| loop | change | measured effect |
|---|---|---|
| 9 | turn-batching recipe + verbatim briefs; **nx8** corpus (8 foreign parts) | nx8 S(8)=0.53x — parts the serial arm writes in batched turns do not divide |
| 10 | `MINI_AGENT_TEMPERATURE=0` default | variance fell but t10 locked into a 36-second thinking path (34.7-52.6 s at 1.0 -> 88.9 s) |
| 11 | **nx4b** corpus: four foreign projects whose suites fail in staged ways | solvability proven 4/4 both directions; **S(4)=1.59x — division wins when each part owns a test->fix loop** |
| 12 | temp 0.2 + an explicit three-turn recipe for small tasks | recipe verified (t3 down to exactly 3 turns); temp 0.2 cost t4 (158.2 s) |
| 13 | thinking budget 512 by default (was 2048; wave workers 1024->512) | **mini 587.6 s vs pi 655.0 same day — 1.11x, 10/10 PASS** |
| 14 | targeted edits over full-file rewrites | no more whole-file regenerations (t4 154.2 -> 132.2, one 68.4 s gateway spike inside); **mini 617.6 vs 655.0 — 1.06x, 10/10** |

## Goal A standing (2026-10-22)

Totals: mini wins every validated rep today against the same-day pi reference
(587.6/617.6 vs 655.0) plus yesterday's 497.7 vs 550.9. Per-task: 5-6 of 10
wins; the losses are 5-15 s margins on small tasks (inside the measured
cross-rep noise, pi swings 550-655 across its own reps) plus t4, whose gap is
dominated by gateway-latency spikes (a 68.4 s round trip for a 29-byte
`node --version`) and by being the corpus's most thorough task. t7 — the
harness's historical disaster (1192.8 s on 2026-10-20) — is now a mini win on
every rep (56.1-88.1 s vs pi's 44.6-210.3).

## Goal B standing

S(N) by part shape (the motif's honest boundary):

- seconds-scale parts a serial session can batch: S(8)=0.53x
- minutes-scale homogeneous parts: S(8)=1.62-1.63x
- **minutes-scale foreign parts with per-part test->fix loops: S(4)=1.59x
  and rising with part size** — the regime where division wins

The Nx limit stays Amdahl's: with the wave's fixed cost at ~60 s and the
measured per-part parity gap, the ceiling for N=4 is ~3.2x and for N=8 ~6x
(0.75-0.8 N) once workers match the serial arm's per-part efficiency.
