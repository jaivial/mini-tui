#!/usr/bin/env bash
# Contention gate: refuse to start a timed FrontierHarness run while another
# session is doing speed rounds on this machine, because parallel load
# contaminates both wall-clock and pass-rate measurements.
#
#   bash frontier_gate.sh check        # exit 0 if clear, 1 if busy
#   bash frontier_gate.sh wait [mins]  # poll until clear (default 60 min)
set -uo pipefail
SID=${FH_BUSY_SESSION:-s-mv2iwsb314a9}
URL=${FH_BUSY_URL:-http://127.0.0.1:4317/sessions/$SID}
MODE=${1:-check}; LIMIT=${2:-60}

status() { curl -s -m 8 "$URL" 2>/dev/null | jq -r '.status // "unknown"'; }

if [ "$MODE" = "wait" ]; then
  waited=0
  while [ "$waited" -lt $((LIMIT * 6)) ]; do
    s=$(status)
    if [ "$s" != "running" ]; then echo "clear ($s) after ${waited}0s"; exit 0; fi
    echo "$(date +%H:%M:%S) busy ($s), waited ${waited}0s"; sleep 10; waited=$((waited+1))
  done
  echo "still busy after ${LIMIT} min"; exit 1
fi

s=$(status)
echo "$SID: $s"
[ "$s" = "running" ] && { echo "BLOCKED: another session is running speed rounds; measurements would be contaminated"; exit 1; }
exit 0
