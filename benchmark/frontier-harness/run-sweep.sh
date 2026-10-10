#!/usr/bin/env bash
# Full FrontierHarness sweep: mini and the pi control, both suites, machine-idle only.
#
# Waits for the machine to be free, then runs every arm back to back so the arms see
# the same conditions. Safe to leave running: it exits immediately rather than
# contaminating a concurrent speed round.
set -uo pipefail
FH_ROOT=${FH_ROOT:-$HOME/frontier-harness-eval}
GATE=$HOME/mini-tui-benchmark/frontier_gate.sh
WAIT_MIN=${FH_WAIT_MIN:-240}
cd "$FH_ROOT"

echo "==> waiting up to ${WAIT_MIN} min for an idle machine"
bash "$GATE" wait "$WAIT_MIN" || { echo "machine never went idle; nothing was run"; exit 75; }

for arm in mini pi; do
  for suite in terminal-bench deepswe; do
    tasks=tasks-subset.txt; [ "$suite" = deepswe ] && tasks=tasks-deepswe.txt
    echo "==> $arm / $suite"
    FH_SUITE=$suite FH_TASKS=$tasks \
      FH_RUN_ID="$(date -u +%Y-%m-%d)-$arm-$suite" \
      bash run-baseline.sh "$arm" || echo "arm $arm/$suite failed; continuing"
  done
done

echo "==> scoring"
for d in jobs/*/; do
  [ -d "$d" ] || continue
  echo "--- $d"
  python3 frontier_score.py "$d" || true
done
