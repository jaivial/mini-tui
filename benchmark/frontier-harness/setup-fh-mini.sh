#!/usr/bin/env bash
# One-shot setup for evaluating mini-agent-rs (mini-tui) on FrontierHarness Eval.
#
# Installs the pinned benchmark stack into an isolated venv, fetches the
# Terminal-Bench dataset, and records the provenance of the harness under test.
# Idempotent: re-running only re-fetches what is missing.
set -euo pipefail

FH_ROOT=${FH_ROOT:-$HOME/frontier-harness-eval}
HARBOR_PIN=${HARBOR_PIN:-0.22.0}
DEEP_SWE_REF=${DEEP_SWE_REF:-435ee89ec2f2e2289f33b0da4f992f0b7b7266b9}

MINI_BIN=${MINI_AGENT_RS_BIN:-$HOME/.local/lib/mini-tui/mini-agent-rs}
MINI_CONFIG_DIR=${MINI_AGENT_CONFIG_DIR:-$HOME/mini-tui/agent/src/minisweagent/config}

mkdir -p "$FH_ROOT/.tools"
cd "$FH_ROOT"

echo "==> python 3.12 venv + harbor==$HARBOR_PIN"
if [ ! -x .tools/hbenv/bin/harbor ]; then
  uv venv --python 3.12 .tools/hbenv
  uv pip install --python .tools/hbenv/bin/python "harbor==$HARBOR_PIN"
fi
.tools/hbenv/bin/harbor --version

echo "==> terminal-bench@2.0 dataset (21 of 89 tasks are in scope)"
[ -d terminal-bench ] || .tools/hbenv/bin/harbor download 'terminal-bench@2.0'

echo "==> deep-swe corpus @ $DEEP_SWE_REF (9 tasks, needs Pier)"
if [ ! -d deep-swe ]; then
  git clone --quiet https://github.com/datacurve-ai/deep-swe deep-swe
  git -C deep-swe checkout --quiet "$DEEP_SWE_REF"
fi
if [ "${INSTALL_PIER:-0}" = "1" ]; then
  uv tool install --quiet 'datacurve-pier==0.3.1'
  "$HOME/.local/bin/pier" --version
fi

# Task lists: the 21 Terminal-Bench and 9 DeepSWE tasks the benchmark scores.
python3 - <<'PY'
import json
ids = json.load(open('benchmark.json'))['task_ids']
for prefix, out in (('terminal-bench/', 'tasks-subset.txt'), ('datacurve/', 'tasks-deepswe.txt')):
    picked = [i.split('/', 1)[1] for i in ids if i.startswith(prefix)]
    open(out, 'w').write("\n".join(picked) + "\n")
    print(f"{out}: {len(picked)} tasks")
PY

echo "==> harness under test"
test -x "$MINI_BIN" || { echo "missing mini-agent-rs binary: $MINI_BIN" >&2; exit 1; }
test -d "$MINI_CONFIG_DIR" || { echo "missing config dir: $MINI_CONFIG_DIR" >&2; exit 1; }

mkdir -p runs
cat > runs/harness-provenance.json <<JSON
{
  "harness": "mini-agent-rs",
  "binary": "$MINI_BIN",
  "binary_sha256": "$(sha256sum "$MINI_BIN" | cut -d' ' -f1)",
  "config_dir": "$MINI_CONFIG_DIR",
  "model": "Kimi K3",
  "model_route": "opencode-go/kimi-k3",
  "harbor": "$HARBOR_PIN",
  "dataset": "terminal-bench@2.0",
  "deep_swe_ref": "$DEEP_SWE_REF"
}
JSON
cat runs/harness-provenance.json

echo
echo "setup complete. next:"
echo "  bash $FH_ROOT/run-baseline.sh <arm>"
echo "  arms: mini | pi | oracle"