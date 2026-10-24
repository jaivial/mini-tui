# mini queue vs pi

Deterministic local A/B for the assigned-task path: chat dispatcher → queue → mini worker, compared
with headless pi. Every task starts from a fresh copy and is scored by its own `verify.sh` after the
agent exits. A confident final answer is not a pass.

## Controlled MiMo campaign

```bash
cd benchmark/pi-vs-mini
REPS=3 ./run_mimo_queue_ab.sh
```

The launcher uses `xiaomi/mimo-v2.6-flash` for mini and
`xiaomi-anthropic/mimo-v2.6-flash` for pi, both on the Singapore token-plan Anthropic surface.
It reads the credential from `~/.config/mini-tui-web.env` only when `XIAOMI_API_KEY` is not already
set; it never prints the key or changes the global provider registry.

The web server, settings, session DB and trajectories are isolated under `/tmp`. Do not run two
speed campaigns at once. The default is ten tasks × three repetitions per arm, interleaved task by
task, with the arm order reversed on alternate repetitions.

For a shorter or differently shaped campaign:

```bash
# Selected tasks, two repetitions.
REPS=2 TASKS="t1_wordfreq t4_refactor t8_js_bug" ./run_mimo_queue_ab.sh

# Unitary control, four foreign test→fix projects, and eight larger independent items.
BENCH_TASKS_DIR=$PWD/parallel REPS=1 \
  TASKS="tp1_single nx4b_wave big8_wave" WEB_PORT=4411 \
  ./run_mimo_queue_ab.sh
```

The `parallel` corpus is a separate experiment; never add its pass rate or wall time to the
 ten-task corpus's result.

## Validation and report

```bash
python3 analyze_queue.py runs/queue-YYYYMMDD-HHMMSS
```

Writes `analysis.json` and `REPORT.md` in the run directory. The report contains per-task and
per-level medians, every repetition, pass counts, and two independent gates:

- **assigned worker:** `sum(pi task medians) / sum(mini worker medians) ≥ 2`, with mini pass rate
  greater than or equal to pi;
- **end-to-end:** the same calculation with dispatch included.

A result is not a valid campaign when a cell is missing, mini did not finish, pi exited non-zero,
or pi produced no assistant turn. Infrastructure-invalid runs abort instead of being counted as
model/task failures. Completed runs that fail `verify.sh` remain real FAIL rows.

The difficulty labels in `analyze_queue.py` are editorial descriptions of task shape, not a
calibrated human-difficulty scale. Time and pass rate are always shown per task as well as in
aggregate; the sum-of-medians ratio must not be confused with the ratio of all wall times.

## Artifact integrity

- `methodology.json` records model/provider, corpus, repetitions, timeout, git HEAD/dirty state,
  binary path and SHA-256.
- Tagged repetitions keep separate pi event streams/workspaces and mini trajectories.
- `verify.sh` is harness-owned. Before scoring, the pristine verifier for the **original task ID**
  is restored if an agent modified or deleted it; tampering is recorded. Tagged `.rN` workspaces
  cannot bypass this by changing the directory basename.
- A mini request that becomes several queue tasks is measured from the first worker start to the
  last worker finish (wave makespan), not merely from the first card.
- `workers[]` retains every card, session, trajectory and per-worker timing when fan-out occurs.

Raw runs live under `runs/` and are local evidence, not publishable benchmark claims by themselves.
The historical result cited in `docs/work-queue.md` is
`runs/queue-20261024-031939`: 30/30 PASS on both arms and 2.26× assigned-worker speedup.
