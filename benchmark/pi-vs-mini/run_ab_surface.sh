#!/usr/bin/env bash
# Surface A/B on the pi-vs-mini corpus: the SAME mini-direct harness (mini-tui-web,
# MINI_AGENT_DEPTH=1) against the Xiaomi token-plan /v1 OpenAI-chat surface vs the
# /anthropic Messages surface (rolling cache_control). pi over /anthropic as the
# reference arm. Only variable between arms 1 and 2: XIAOMI_API_BASE in the saved
# xiaomi connection (~/.config/mini-tui/providers.json), read at every agent spawn.
set -uo pipefail
cd "$(dirname "$0")"

export BENCH_MODEL="xiaomi/mimo-v2.6-flash"
export BENCH_PI_PROVIDER="xiaomi-anthropic"
export BENCH_PI_MODEL="mimo-v2.6-flash"
export XIAOMI_API_KEY="tp-ssspkijxwfpo6gycb4c8j48ctuc49f3mtj584l5ccmjtd9tp"
PORT=4392
export MINITUI_WEB_PORT=$PORT

set_surface() { # $1 = base url for XIAOMI_API_BASE
  python3 - "$1" <<'PYEOF'
import json, os, sys
base = sys.argv[1]
p = os.path.expanduser("~/.config/mini-tui/providers.json")
conns = json.load(open(p))
for c in conns:
    if c.get("id") == "xiaomi":
        c.setdefault("extraEnv", {})["XIAOMI_API_BASE"] = base
        c["baseUrl"] = base
with open(p, "w") as f:
    json.dump(conns, f, indent=2)
    f.write("\n")
os.chmod(p, 0o600)
print("surface ->", base)
PYEOF
}

web_start() {
  MINITUI_WEB_HOST=127.0.0.1 MINITUI_WEB_PORT=$PORT MINI_AGENT_DEPTH=1 \
    nohup /home/jaime/.bun/bin/bun run /home/jaime/mini-tui/src/web/serve.ts \
    > /tmp/opencode/bench-web-$PORT.log 2>&1 &
  echo $! > /tmp/opencode/bench-web.pid
  for _ in $(seq 1 60); do
    sleep 1
    if curl -sf "http://127.0.0.1:$PORT/api/sessions" >/dev/null; then echo "web up on $PORT"; return 0; fi
  done
  echo "web FAILED to start"; tail -20 "/tmp/opencode/bench-web-$PORT.log"; return 1
}

web_stop() {
  [ -f /tmp/opencode/bench-web.pid ] && kill "$(cat /tmp/opencode/bench-web.pid)" 2>/dev/null
  rm -f /tmp/opencode/bench-web.pid
  sleep 2
}

echo "############ ARM 1/3: mini-direct /v1 ($(date -u +%H:%M:%SZ)) ############"
set_surface "https://token-plan-sgp.xiaomimimo.com/v1"
web_stop; web_start
python3 run_bench.py --mini-only

echo "############ ARM 2/3: mini-direct /anthropic ($(date -u +%H:%M:%SZ)) ############"
set_surface "https://token-plan-sgp.xiaomimimo.com/anthropic/v1"
web_stop; web_start
python3 run_bench.py --mini-only

echo "############ ARM 3/3: pi /anthropic ($(date -u +%H:%M:%SZ)) ############"
python3 run_bench.py --pi-only

web_stop
echo "############ A/B COMPLETE $(date -u +%H:%M:%SZ) ############"
ls -dt runs/* | head -4
