# FrontierHarness Eval scripts (mini-agent-rs)

The scripts used to evaluate `mini-agent-rs` (mini-tui) as an agent under
[FrontierHarness Eval v1](https://frontierharness.org). Kept here so the run is
reproducible from this repo; the harness checkout lives at `~/frontier-harness-eval`.

```bash
bash setup-fh-mini.sh      # venv 3.12 + harbor 0.22 + terminal-bench@2.0 + deep-swe corpus
bash run-sweep.sh          # both arms x both suites, gated on an idle machine
python3 frontier_score.py jobs/<run-id>     # pass_rate under the harness's own rules
python3 analyze-sweep.py  jobs/<run-id>     # per-task, against the published data
```

## Result of the 2026-10-10 run

**Partial.** 5 valid cells of the mini / Terminal-Bench arm, 4 passes, then the weekly
OpenCode Go quota was exhausted and the sweep was halted. See
[`results/mini-agent-rs/README.md`](results/mini-agent-rs/README.md). Neither 80.0 % over
5 cells nor 13.3 % over 30 is a FrontierHarness score.

What it does establish: mini passed **4 of 4 universal tasks**, and failed the one task
that **0 of 12** published harnesses solve (26 of 27 verifier tests passed there; only a
speed assertion missed by 37 µs). Efficiency was **6.5 model calls and $0.0508 per proven
pass**, against a published Codex median of 62.35 turns and $1.778 per pass.

## Files

| file | what it does |
|---|---|
| `frontier_gate.sh` | refuses a timed run while another session is doing speed rounds |
| `run-sweep.sh` | waits for an idle machine, then runs every arm back to back |
| `run-baseline.sh` | one arm (mini / pi / oracle), records `methodology.json` |
| `frontier_score.py` | the harness's pass-rate accounting; exits non-zero on a partial matrix |
| `analyze-sweep.py` | per-task failure reasons and cost/turns per pass |
| `setup-fh-mini.sh` | pinned stack and task lists |
| `wait-sweep.sh` | reports sweep progress without polling by hand |

## Three defects fixed here

All three would have produced numbers that were wrong *without looking wrong*.

1. **`frontier_score.py` counted no trials.** It read
   `jobs/<run>/<task>__<hash>/result.json`, but Harbor nests an extra timestamped
   directory. At the path `run-sweep.sh` passes, the matrix scored **0/30 with every task
   `missing`** and no error at all. Both depths are now accepted, and `task_name` is
   required so the run-level summary is not scored as a task named after the run.
2. **The `pi` arm ran without an API key.** Harbor infers the provider from the model
   prefix (`opencode-go`) and looks the key up in that provider's registered env names.
   `opencode-go` is not registered, so no key env was ever probed and `PI_API_KEY` /
   `PI_BASE_URL` were silently ignored — the control would have run unauthenticated.
   `pi` now goes through the registered `openai` provider with the gateway in `OPENAI_*`.
3. **DeepSWE ran mini for every arm.** That branch hardcoded
   `--agent-import-path mini_agent_rs:MiniAgentRs` regardless of arm, so the "pi control"
   on the 9 DeepSWE tasks would have been mini itself. The agent is now selected per arm,
   and the run refuses out loud when pier cannot provide the requested arm.

## Scoring rules

Both scorers only ever compare **valid cells**. A cell counts as proven only when a
verifier reward ≥ 1 *plus* observed model usage is present; a crash with no usage is
infra-invalid and is reported separately rather than scored as a task failure. A trial
that started and then timed out is a proven failure. This is what stops an incomplete
matrix from being read as a score.