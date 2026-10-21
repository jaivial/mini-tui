#!/usr/bin/env bash
# MiMo V2.6 Flash harness benchmark: mini-tui-web (orchestrator + direct) vs pi.
# Every arm runs the same 10-task corpus with deterministic verify.sh checks.
# Run under ~/safe-cgroup/safe-run.sh so nothing can take the box down.
set -uo pipefail
cd "$(dirname "$0")"

export BENCH_MODEL="xiaomi/mimo-v2.6-flash"
export BENCH_PI_PROVIDER="xiaomi-token-plan-sgp"
export BENCH_PI_MODEL="mimo-v2.6-flash"

pass () { # $1 label  $2 extra args  $3 web port
  echo; echo "############ PASS $1  ($(date -u +%H:%M:%SZ)) load=$(cut -d' ' -f1 /proc/loadavg) ############"
  if [ "$1" = "pi" ]; then
    python3 run_bench.py --pi-only
  else
    MINITUI_WEB_PORT="$3" python3 run_bench.py --mini-only
  fi
  echo "############ PASS $1 done ($(date -u +%H:%M:%SZ)) ############"
}

pass "mini-orch"   "" 4391
pass "mini-direct" "" 4392
pass "pi"          "" ""

echo; echo "ALL PASSES COMPLETE $(date -u +%H:%M:%SZ)"
ls -dt runs/* | head -3
