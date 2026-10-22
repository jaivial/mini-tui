#!/usr/bin/env bash
# BIZ-59 F1: the full Terminal-Bench 2.0 sample (10 tasks) against the optimized
# mini-agent-rs build of this checkout. One harbor job per task, one trial per job,
# strictly sequential — every harbor invocation inside a cgroup scope
# (CPUQuota=200% / MemoryMax=6G) so F1 cannot take the machine.
#
#   bash benchmark/terminal-bench/setup.sh     # once (already done for F0)
#   bash benchmark/terminal-bench/run_f1.sh    # this: 10 jobs + 10 receipt rows
#
# One job per task (instead of F0's single job with two tasks) so that:
#   - the receipt gets one row per task (run_id identifies the task),
#   - a crash mid-phase loses at most the task in flight, and
#   - rerunning this script RESUMES: tasks that already have an F1 receipt row are
#     skipped, never retouched (an exception row is a real outcome and stays).
#
# Knobs (env): DATASET, TASKS (default: every task dir in DATASET), MODEL,
#   XIAOMI_SURFACE, KEY_FILE, WALL_LIMIT, STEP_LIMIT — same defaults as F0, so the
#   F1 rows stay comparable with the pilot rows (the effective per-trial ceiling is
#   the task's own [agent] timeout_sec, 900 s in the sample).
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR"

REPO_ROOT=${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}
BENCH_ROOT=${BENCH_ROOT:-$HOME/orq/mc18-bughunt/bench}
HARBOR="$BENCH_ROOT/hbenv/bin/harbor"
PY="$BENCH_ROOT/hbenv/bin/python"
DATASET=${DATASET:-$BENCH_ROOT/dataset/sample/terminal-bench-sample}
DATASET_LABEL=${DATASET_LABEL:-terminal-bench-sample@2.0}
MODEL=${MODEL:-xiaomi/mimo-v2.6-flash}
XIAOMI_SURFACE=${XIAOMI_SURFACE:-https://token-plan-sgp.xiaomimimo.com/anthropic/v1}
KEY_FILE=${KEY_FILE:-$HOME/.config/mini-tui-web.env}
WALL_LIMIT=${WALL_LIMIT:-600}
STEP_LIMIT=${STEP_LIMIT:-50}

export PYTHONPATH="$REPO_ROOT/benchmark/terminal-bench${PYTHONPATH:+:$PYTHONPATH}"
export MINI_AGENT_RS_BIN=${MINI_AGENT_RS_BIN:-$REPO_ROOT/agent-rs/target/x86_64-unknown-linux-musl/release/mini-agent-rs}

[ -x "$HARBOR" ] || { echo "harbor missing: $HARBOR (run setup.sh first)" >&2; exit 1; }
[ -d "$DATASET" ] || { echo "dataset missing: $DATASET (run setup.sh first)" >&2; exit 1; }
[ -x "$MINI_AGENT_RS_BIN" ] || { echo "mini-agent-rs missing: $MINI_AGENT_RS_BIN (run setup.sh first)" >&2; exit 1; }

# The sample is enumerated from the dataset on disk — the receipt has to cover what
# is actually there, not a hand-typed list that can drift from the download.
TASKS=${TASKS:-$(find "$DATASET" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)}
RECEIPT_CSV="$REPO_ROOT/benchmark/terminal-bench/receipt/runs.csv"

scoped() { systemd-run --user --scope -p CPUQuota=200% -p MemoryMax=6G "$@"; }

load_model_credentials() {
  if [ -z "${XIAOMI_API_KEY:-}" ]; then
    [ -f "$KEY_FILE" ] || { echo "missing $KEY_FILE (or export XIAOMI_API_KEY yourself)" >&2; exit 1; }
    set -a
    . "$KEY_FILE"
    set +a
  fi
  # Force the surface *after* sourcing: the credentials file pins the /v1 OpenAI
  # surface, and this benchmark runs against /anthropic (rolling cache), the same
  # surface the optimization campaign was measured on.
  export XIAOMI_API_BASE="$XIAOMI_SURFACE"
}

already_recorded() { # $1 = task name: a closed F1 row exists -> never re-run it
  [ -f "$RECEIPT_CSV" ] || return 1
  # $NF is the phase column; csv rows end with \r (python csv uses \r\n), hence the regex.
  awk -F, -v t="$1" 'NR > 1 && $NF ~ /^F1/ && $7 == t { found = 1 } END { exit !found }' "$RECEIPT_CSV"
}

append_incomplete_row() { # $1 = task, $2 = job dir (may not exist), $3 = harbor exit
  # No closed trial to read: record the phase gap with EMPTY metrics (0 would claim
  # a measurement that never happened) and keep going with the next task.
  "$PY" - "$1" "$2" "$3" "$RECEIPT_CSV" <<'PY'
import csv, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

task, job_dir, exit_code, csv_path = sys.argv[1:5]
head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True,
                      text=True).stdout.strip() or "unknown"
row = {
    "run_id": Path(job_dir).name, "timestamp_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "arm": "mini", "agent": "mini_agent_rs:MiniAgentRs", "model": "xiaomi/mimo-v2.6-flash",
    "dataset": "terminal-bench-sample@2.0", "task_filter": task,
    "n_trials": 0, "n_resolved": "", "score": "", "rewards": "",
    "agent_wall_s_total": "", "agent_wall_s_median": "", "job_wall_s": "",
    "tokens_in": "", "tokens_cache": "", "tokens_out": "", "cost_usd": "",
    "harbor_version": "0.24.0", "mini_commit": head,
    "errors": f"{task}:HarborJobIncomplete(exit={exit_code}, no trial result.json)",
    "artifacts": job_dir if Path(job_dir).is_dir() else "",
    "phase": "F1",
}
p = Path(csv_path)
with p.open(newline="") as fh:
    fields = next(csv.reader(fh))
assert set(fields) == set(row), f"receipt schema drift: {fields} vs {list(row)}"
with p.open("a", newline="") as fh:
    csv.DictWriter(fh, fieldnames=fields).writerow(row)
print(f"receipt(exception) row appended -> {p}")
PY
}

STAMP=$(date -u +%Y%m%d-%H%M%S)
BIN_SHA=$(sha256sum "$MINI_AGENT_RS_BIN" | cut -d' ' -f1)
HEAD=$(git -C "$REPO_ROOT" rev-parse HEAD)
echo "==> F1: $(printf '%s\n' $TASKS | wc -l) tasks | dataset $DATASET_LABEL | model $MODEL"
echo "==> mini-agent-rs bin sha256 $BIN_SHA (checkout $HEAD)"

cat > "$BENCH_ROOT/f1-provenance.json" <<JSON
{
  "repo_commit": "$HEAD",
  "harbor": "$("$HARBOR" --version)",
  "dataset": "$DATASET_LABEL",
  "model": "$MODEL",
  "mini_agent_rs_sha256": "$BIN_SHA",
  "started_at_utc": "$(date -u +%FT%TZ)"
}
JSON
cat "$BENCH_ROOT/f1-provenance.json"

load_model_credentials

FAILURES=0
for task in $TASKS; do
  if already_recorded "$task"; then
    echo "== $task: already has an F1 receipt row — skipping (receipts are append-only)"
    continue
  fi
  job="mini-f1-${task}-${STAMP}"
  echo
  echo "== [$task] $(date -u +%FT%TZ) -> job $job"
  exit_code=0
  scoped "$HARBOR" run -p "$DATASET" -i "$task" \
    -a mini_agent_rs:MiniAgentRs -m "$MODEL" -n 1 -k 1 -y --env docker \
    --job-name "$job" -o "$BENCH_ROOT/jobs" \
    --ak wall_time_limit_sec="$WALL_LIMIT" --ak step_limit="$STEP_LIMIT" \
    || exit_code=$?
  dir="$BENCH_ROOT/jobs/$job"
  if [ ! -d "$dir" ]; then
    # Same rule as the pilot: only accept a suffixed dir when it is unambiguous.
    candidates=()
    while IFS= read -r d; do candidates+=("$d"); done < <(
      find "$BENCH_ROOT/jobs" -mindepth 1 -maxdepth 1 -type d -name "mini-f1-${task}-*" | sort)
    if [ "${#candidates[@]}" -eq 1 ]; then
      dir="${candidates[0]}"
      echo "harbor suffixed the job name; using $(basename "$dir")"
    fi
  fi
  if [ -d "$dir" ] && "$PY" "$REPO_ROOT/benchmark/terminal-bench/record_receipt.py" \
      "$dir" --arm mini --agent mini_agent_rs:MiniAgentRs --model "$MODEL" \
      --dataset "$DATASET_LABEL" --task-filter "$task" --phase F1; then
    :
  else
    echo "!! $task: no closed trial (harbor exit $exit_code) — recording the gap"
    append_incomplete_row "$task" "$dir" "$exit_code"
    FAILURES=$((FAILURES + 1))
  fi
done

echo
echo "== F1 receipt rows (phase F1):"
awk -F, 'NR == 1 || $NF ~ /^F1/' "$RECEIPT_CSV" | column -s, -t
echo
echo "==> F1 finished: $(awk -F, 'NR>1 && $NF ~ /^F1/' "$RECEIPT_CSV" | wc -l) row(s), $FAILURES incomplete job(s)"
[ "$FAILURES" -eq 0 ]
