#!/usr/bin/env bash
# Isolated, interleaved mini-queue vs pi A/B on Xiaomi MiMo V2.6 Flash (Singapore token plan).
# No global provider, settings, session DB, or production web service is modified.
set -euo pipefail
cd "$(dirname "$0")"
REPO=$(cd ../.. && pwd)
PORT=${WEB_PORT:-4410}
REPS=${REPS:-3}
RUN_ROOT=${RUN_ROOT:-/tmp/mini-tui-mimo-ab-$(date +%Y%m%d-%H%M%S)-$$}
mkdir -p "$RUN_ROOT/config" "$RUN_ROOT/runs"

# pi resolves `$XIAOMI_API_KEY` from its provider config; mini reads the same credential
# from providers.json. Load it without echoing it, then pin both arms to the same surface.
if [[ -z "${XIAOMI_API_KEY:-}" ]]; then
  KEY_FILE=${KEY_FILE:-$HOME/.config/mini-tui-web.env}
  [[ -f "$KEY_FILE" ]] || { echo "missing Xiaomi credential: $KEY_FILE" >&2; exit 1; }
  set -a
  # shellcheck disable=SC1090
  . "$KEY_FILE"
  set +a
fi
: "${XIAOMI_API_KEY:?Xiaomi credential is empty}"
export XIAOMI_API_BASE=https://token-plan-sgp.xiaomimimo.com/anthropic/v1

export BENCH_MODEL=${BENCH_MODEL:-xiaomi/mimo-v2.6-flash}
export BENCH_PI_PROVIDER=${BENCH_PI_PROVIDER:-xiaomi-anthropic}
export BENCH_PI_MODEL=${BENCH_PI_MODEL:-mimo-v2.6-flash}
export BENCH_TIMEOUT=${BENCH_TIMEOUT:-900}
export MINITUI_AGENT_BIN=${MINITUI_AGENT_BIN:-$REPO/agent-rs/target/release/mini-agent-rs}
export MINITUI_WEB_HOST=127.0.0.1
export MINITUI_WEB_PORT=$PORT
export MINITUI_CONFIG_DIR=$RUN_ROOT/config
export MINITUI_RUNS_DIR=$RUN_ROOT/runs
export MINITUI_SETTINGS_PATH=$RUN_ROOT/settings.json
export MINITUI_DB_PATH=$RUN_ROOT/sessions.db

BUN=${BUN_BIN:-$(command -v bun)}
"$BUN" run "$REPO/src/web/serve.ts" >"$RUN_ROOT/web.log" 2>&1 &
WEB_PID=$!
cleanup() {
  kill "$WEB_PID" 2>/dev/null || true
  wait "$WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/api/queue" >/dev/null; then break; fi
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    echo "mini web exited; see $RUN_ROOT/web.log" >&2
    exit 1
  fi
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/api/queue" >/dev/null || {
  echo "mini web did not become ready; see $RUN_ROOT/web.log" >&2
  exit 1
}

echo "run root: $RUN_ROOT"
echo "model: $BENCH_MODEL | pi: $BENCH_PI_PROVIDER/$BENCH_PI_MODEL | reps: $REPS"
# shellcheck disable=SC2086
python3 run_queue_bench.py --reps "$REPS" ${TASKS:-}
