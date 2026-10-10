#!/usr/bin/env bash
# Block until the sweep finishes, then report. Prints a line whenever the number of
# trials or the active arm changes, so a long unattended run stays observable.
cd "$HOME/frontier-harness-eval" || exit 1
last=""
while :; do
  alive=$(pgrep -f "run-sweep.sh" >/dev/null && echo yes || echo no)
  trials=$(find jobs -path '*__*/result.json' 2>/dev/null | wc -l)
  arm=$(pgrep -f "hbenv/bin/python .tools/hbenv/bin/harbor run" >/dev/null && echo tb || \
        pgrep -f "pier run" >/dev/null && echo deepswe || echo none)
  state="$arm trials=$trials"
  if [ "$state" != "$last" ]; then
    echo "$(date -u +%FT%TZ) $state"
    last="$state"
  fi
  if [ "$alive" = "no" ]; then
    echo "$(date -u +%FT%TZ) SWEEP FINISHED trials=$trials"
    exit 0
  fi
  sleep 60
done