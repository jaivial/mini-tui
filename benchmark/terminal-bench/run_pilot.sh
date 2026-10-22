#!/usr/bin/env bash
# Bounded Terminal-Bench pilot for BIZ-59: oracle arm + mini-agent-rs arm on two
# Terminal-Bench 2.0 sample tasks, one trial at a time, every harbor invocation inside
# a cgroup scope (CPUQuota=200% / MemoryMax=6G) so the pilot cannot take the machine.
#
#   bash benchmark/terminal-bench/setup.sh        # once: harbor + datasets + binary
#   bash benchmark/terminal-bench/run_pilot.sh    # this: oracle, then mini, then receipts
#
# Knobs (env): ARMS (default "oracle mini"; e.g. ARMS=mini to rerun one arm),
#   DATASET, TASKS, MODEL, XIAOMI_SURFACE, KEY_FILE, WALL_LIMIT, STEP_LIMIT
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR"

REPO_ROOT=${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}
BENCH_ROOT=${BENCH_ROOT:-$HOME/orq/mc18-bughunt/bench}
HARBOR="$BENCH_ROOT/hbenv/bin/harbor"
PY="$BENCH_ROOT/hbenv/bin/python"
DATASET=${DATASET:-$BENCH_ROOT/dataset/sample/terminal-bench-sample}
DATASET_LABEL=${DATASET_LABEL:-terminal-bench-sample@2.0}
TASKS=${TASKS:-"*fix-code-vulnerability* *regex-log*"}
ARMS=${ARMS:-"oracle mini"}
MODEL=${MODEL:-xiaomi/mimo-v2.6-flash}
XIAOMI_SURFACE=${XIAOMI_SURFACE:-https://token-plan-sgp.xiaomimimo.com/anthropic/v1}
KEY_FILE=${KEY_FILE:-$HOME/.config/mini-tui-web.env}
WALL_LIMIT=${WALL_LIMIT:-600}
STEP_LIMIT=${STEP_LIMIT:-50}

export PYTHONPATH="$REPO_ROOT/benchmark/terminal-bench${PYTHONPATH:+:$PYTHONPATH}"
export MINI_AGENT_RS_BIN=${MINI_AGENT_RS_BIN:-$REPO_ROOT/agent-rs/target/x86_64-unknown-linux-musl/release/mini-agent-rs}

[ -x "$HARBOR" ] || { echo "harbor missing: $HARBOR (run setup.sh first)" >&2; exit 1; }
[ -d "$DATASET" ] || { echo "dataset missing: $DATASET (run setup.sh first)" >&2; exit 1; }

include_args=()
for t in $TASKS; do include_args+=(-i "$t"); done

scoped() { systemd-run --user --scope -p CPUQuota=200% -p MemoryMax=6G "$@"; }

harbor_run() { # $1 = job name, $2 = agent, rest = extra harbor args
  local job=$1 agent=$2
  shift 2
  scoped "$HARBOR" run -p "$DATASET" "${include_args[@]}" \
    -a "$agent" -n 1 -k 1 -y --env docker --job-name "$job" -o "$BENCH_ROOT/jobs" "$@"
}

receipt() { # $1 = job name, $2 = arm, $3 = agent, $4 = model
  local dir="$BENCH_ROOT/jobs/$1"
  if [ ! -d "$dir" ]; then
    # Harbor may suffix the job name. Only fall back when it is unambiguous: exactly
    # one job dir created since this run started, and report which one was used —
    # a receipt row must never be attributed to a job it did not come from.
    local candidates=()
    while IFS= read -r d; do candidates+=("$d"); done < <(
      find "$BENCH_ROOT/jobs" -mindepth 1 -maxdepth 1 -type d -newer "$RUN_MARKER" 2>/dev/null | sort)
    if [ "${#candidates[@]}" -ne 1 ]; then
      echo "receipt: $dir missing and ${#candidates[@]} new job dirs; refusing to guess" >&2
      return 1
    fi
    dir="${candidates[0]}"
    echo "receipt: job dir suffixed by harbor; using $(basename "$dir")"
  fi
  [ -d "$dir" ] || { echo "no job dir found for $1" >&2; return 1; }
  "$PY" "$REPO_ROOT/benchmark/terminal-bench/record_receipt.py" \
    "$dir" --arm "$2" --agent "$3" --model "$4" \
    --dataset "$DATASET_LABEL" --task-filter "$TASKS" --phase F0
}

load_model_credentials() {
  if [ -z "${XIAOMI_API_KEY:-}" ]; then
    [ -f "$KEY_FILE" ] || { echo "missing $KEY_FILE (or export XIAOMI_API_KEY yourself)" >&2; exit 1; }
    set -a
    . "$KEY_FILE"
    set +a
  fi
  # Force the surface *after* sourcing: the credentials file pins the /v1 OpenAI
  # surface, and this harness comparison is run against /anthropic (rolling cache).
  export XIAOMI_API_BASE="$XIAOMI_SURFACE"
}

STAMP=$(date -u +%Y%m%d-%H%M%S)
RUN_MARKER="$BENCH_ROOT/.pilot-start-$$"
touch "$RUN_MARKER"
trap 'rm -f "$RUN_MARKER"' EXIT

for arm in $ARMS; do
  case "$arm" in
    oracle)
      echo "== oracle arm (no model: proves the task images and verifiers on this host)"
      harbor_run "oracle-pilot-$STAMP" oracle
      receipt "oracle-pilot-$STAMP" oracle oracle ""
      ;;
    mini)
      echo "== mini-agent-rs arm ($MODEL over the token-plan /anthropic surface)"
      load_model_credentials
      harbor_run "mini-pilot-$STAMP" mini_agent_rs:MiniAgentRs -m "$MODEL" \
        --ak wall_time_limit_sec="$WALL_LIMIT" --ak step_limit="$STEP_LIMIT"
      receipt "mini-pilot-$STAMP" mini mini_agent_rs:MiniAgentRs "$MODEL"
      ;;
    *)
      echo "unknown arm: $arm (expected oracle|mini)" >&2
      exit 2
      ;;
  esac
done

echo
echo "== receipt (benchmark/terminal-bench/receipt/runs.csv)"
column -s, -t < "$REPO_ROOT/benchmark/terminal-bench/receipt/runs.csv" 2>/dev/null \
  || cat "$REPO_ROOT/benchmark/terminal-bench/receipt/runs.csv"
