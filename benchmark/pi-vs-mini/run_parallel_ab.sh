#!/usr/bin/env bash
# Delegation A/B on the decomposable corpus (parallel/): mini-direct
# (MINI_AGENT_DEPTH=1, one agent does every part serially) vs mini-orch
# (top-level session, router arms the orchestrator lane, fan-out wave).
# Both arms on the /anthropic surface, same model. tp1_single is the unitary
# control: the router should keep it direct in BOTH arms.
set -uo pipefail
cd "$(dirname "$0")"

export BENCH_MODEL="xiaomi/mimo-v2.6-flash"
export BENCH_TASKS_DIR="$(pwd)/parallel"
PORT_ORCH=4391
PORT_DIRECT=4392

set_surface() {
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

web_start() { # $1 port  $2 extra env (empty or MINI_AGENT_DEPTH=1)
  local port=$1
  if [ -n "$2" ]; then local extra="$2"; else local extra=""; fi
  env MINITUI_WEB_HOST=127.0.0.1 MINITUI_WEB_PORT=$port $extra \
    nohup /home/jaime/.bun/bin/bun run /home/jaime/mini-tui/src/web/serve.ts \
    > /tmp/opencode/bench-web-$port.log 2>&1 &
  echo $! > /tmp/opencode/bench-web-$port.pid
  for _ in $(seq 1 60); do
    sleep 1
    if curl -sf "http://127.0.0.1:$port/api/sessions" >/dev/null; then echo "web up on $port"; return 0; fi
  done
  echo "web FAILED on $port"; tail -20 "/tmp/opencode/bench-web-$port.log"; return 1
}

web_stop() {
  local port=$1
  [ -f /tmp/opencode/bench-web-$port.pid ] && kill "$(cat /tmp/opencode/bench-web-$port.pid)" 2>/dev/null
  rm -f /tmp/opencode/bench-web-$port.pid
  sleep 2
}

set_surface "https://token-plan-sgp.xiaomimimo.com/anthropic/v1"

echo "############ ARM 1/2: mini-direct (baseline serial) ($(date -u +%H:%M:%SZ)) ############"
web_stop $PORT_DIRECT; web_start $PORT_DIRECT "MINI_AGENT_DEPTH=1"
MINITUI_WEB_PORT=$PORT_DIRECT python3 run_bench.py --mini-only

echo "############ ARM 2/2: mini-orch (router + fan-out wave) ($(date -u +%H:%M:%SZ)) ############"
web_stop $PORT_ORCH; web_start $PORT_ORCH ""
MINITUI_WEB_PORT=$PORT_ORCH python3 run_bench.py --mini-only

web_stop $PORT_DIRECT; web_stop $PORT_ORCH
echo "############ PARALLEL A/B COMPLETE $(date -u +%H:%M:%SZ) ############"
ls -dt runs/* | head -3
