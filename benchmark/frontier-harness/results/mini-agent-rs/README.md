# mini-agent-rs on FrontierHarness Eval

Local evaluation of `mini-agent-rs` (mini-tui) as an agent under FrontierHarness Eval v1.

## Status: partial run, stopped by provider quota

The sweep of 2026-10-10 ran on an idle machine and produced **5 valid cells of the
mini / Terminal-Bench arm** before OpenCode Go began rejecting every completion with
`GoUsageLimitError` (`limit_name: weekly`). It was halted rather than continued.

**Neither number below is a FrontierHarness score:**

| figure | value | why it is not a score |
|---|---|---|
| `pass_rate` | 80.0 % | over 5 valid cells; 25 of 30 were never run |
| `success/expected` | 13.3 % | 4 of 30, and the 4 are 4 of the 12 tasks the published field solves universally |

Do not quote either one as a result. The correct summary is "4 of 5 valid cells passed,
the run was then blocked by a weekly provider quota."

## What was measured

| task | field | class | result | min | api calls | cost |
|---|---|---|---|---|---|---|
| log-summary-date-ranges | 12/12 | universal | PASS | 0.7 | 4 | $0.028 |
| merge-diff-arc-agi-task | 12/12 | universal | PASS | 1.2 | 14 | $0.090 |
| modernize-scientific-stack | 12/12 | universal | PASS | 0.8 | 3 | $0.031 |
| multi-source-data-merger | 12/12 | universal | PASS | 1.2 | 5 | $0.055 |
| largest-eigenval | 0/12 | solved-by-nobody | FAIL | 5.3 | 24 | $0.324 |

**4 of 4 universal tasks passed** — the floor the plan assumed. The single failure is a
task **0 of 12 harnesses in the published field solve**, and the verifier shows exactly
why: 26 of 27 tests pass, failing only `test_speedup[8]` by 37 microseconds.

Efficiency: **6.5 model calls and $0.0508 per proven pass**, against a published Codex
median of 62.35 turns and $1.778 per pass.

## Evidence integrity

All 5 retained trials finished before the first HTTP 429 at 16:07:57Z, so no retained
cell is contaminated by the quota outage. The trial that was in flight when the quota
died (`chess-best-move`) wrote no `result.json`, so it appears as `missing` and inflates
neither the pass rate nor the failure count.

## Files

- `sweep-2026-10-10-partial.json` — the abort record: exact provider error, timing, and
  which cells are safe to trust.
- `sweep-2026-10-10-analysis.json` — per-task rows with tokens, cost, duration and the
  published field rate for each task.
- `methodology.json` — divergences from the published protocol (local Docker instead of
  Runta golden checkpoints, Kimi K3 via OpenCode Go instead of Fireworks).

## Reproducing / resuming

```bash
bash ~/frontier-harness-eval/setup-fh-mini.sh
bash ~/frontier-harness-eval/run-sweep.sh
python3 ~/frontier-harness-eval/frontier_score.py jobs/<run-id>
python3 ~/frontier-harness-eval/analyze-sweep.py jobs/<run-id>
```

`run-sweep.sh` refuses to start while another session is running speed rounds
(`~/mini-tui-benchmark/frontier_gate.sh`), and exits 75 if the machine never frees up. It
is idempotent per arm, so once the weekly quota resets the remaining tasks can be appended
to the same matrix. **Any task that ran during a 429 window must be re-run, not counted.**