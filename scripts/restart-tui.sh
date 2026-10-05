#!/usr/bin/env bash
# Restart the mini-tui TERMINAL UI only. Never touches mini-tui-web.service,
# so the web app and every run it owns keep going.
set -u

PROJECT="${MINITUI_HOME:-$HOME/mini-tui}"
START=(bun "$PROJECT/src/index.ts")

echo "== mini-tui terminal TUI restart =="

# The TUI is `bun .../src/index.ts`; the web app is `bun .../src/web/serve.ts`.
mapfile -t tuis < <(pgrep -f "bun $PROJECT/src/index\.ts( |$)")
if [ ${#tuis[@]} -eq 0 ]; then
  echo "no terminal TUI running - starting a fresh one"
else
  echo "found terminal TUI: ${tuis[*]}"
  # Warn about runs this TUI would orphan, so nothing is lost by surprise.
  for pid in "${tuis[@]}"; do
    kids=$(ps --ppid "$pid" -o pid= 2>/dev/null | wc -l)
    if [ "$kids" -gt 0 ]; then
      echo "  WARNING: TUI $pid still owns $kids run(s); they will stop at their next step."
      echo "           Sessions are saved, so `/resume` brings them back."
    fi
  done
  kill "${tuis[@]}" 2>/dev/null
  for i in $(seq 1 30); do
    pgrep -f "bun $PROJECT/src/index\.ts( |$)" >/dev/null || break
    sleep 0.1
  done
  # Still alive? Then it is stuck in a child; escalate.
  if pgrep -f "bun $PROJECT/src/index\.ts( |$)" >/dev/null; then
    echo "  still up - sending SIGKILL"
    pkill -KILL -f "bun $PROJECT/src/index\.ts( |$)" 2>/dev/null
    sleep 0.3
  fi
  echo "stopped"
fi

echo "starting: ${START[*]}"
cd "$PROJECT" || exit 1
exec "${START[@]}"
