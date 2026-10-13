#!/usr/bin/env bash
# Frozen 21 Terminal-Bench + 9 DeepSWE, one full paired repetition.
set -euo pipefail
REP=${1:?usage: run-lb30-complete.sh REP}
[[ "$REP" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'invalid repetition ID' >&2; exit 2; }
FH_ROOT=${FH_ROOT:-$HOME/frontier-harness-eval}
MINI_SOURCE=${MINI_SOURCE:-$HOME/mini-tui-goal-loop}
export PATH="$HOME/.local/bin:$HOME/.local/share/uv/tools/datacurve-pier/bin:$PATH"
export FH_CONCURRENCY=1 FH_STEP_LIMIT=0 FH_AGENT_TIMEOUT=5400
export MINI_AGENT_RS_BIN=${MINI_AGENT_RS_BIN:?pin benchmark binary, never replace terminal}
export MINI_AGENT_CONFIG_DIR="$MINI_SOURCE/agent/src/minisweagent/config"
export FH_PI_NODE=${FH_PI_NODE:-$HOME/.nvm/versions/node/v24.18.0/bin/node}
export FH_PI_PACKAGE=${FH_PI_PACKAGE:-$HOME/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent}
export ROSETTA_API_KEY=${ROSETTA_API_KEY:-rosetta-local}
export ROSETTA_API_BASE=http://127.0.0.1:9120/v1
export FH_ROSETTA_CONTAINER_BASE=http://172.17.0.1:9121
export PYTHONPATH="$MINI_SOURCE/benchmark/frontier-harness:$FH_ROOT/harness${PYTHONPATH:+:$PYTHONPATH}"
cd "$FH_ROOT"
# Never override the contention/production safety gates for headline measurements.
bash "$HOME/mini-tui-benchmark/frontier_gate.sh" check
bash fh-guard.sh pre
bash rosetta-bridge.sh start
mkdir -p "runs/lb30-$REP"
python3 - "$REP" <<'PY'
import json, pathlib, sys, hashlib, os, subprocess
root=pathlib.Path('.'); manifest=json.loads((root/'benchmark.json').read_text()); ids=manifest['task_ids']
if len(ids)!=30 or len(set(ids))!=30: raise SystemExit('frozen task manifest must contain 30 unique IDs')
binary=pathlib.Path(os.environ['MINI_AGENT_RS_BIN'])
provenance={'manifest_sha256':hashlib.sha256((root/'benchmark.json').read_bytes()).hexdigest(), 'mini_binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(), 'mini_source_commit':subprocess.check_output(['git','-C',os.environ.get('MINI_SOURCE',str(pathlib.Path.home()/'mini-tui-goal-loop')),'rev-parse','HEAD'],text=True).strip(), 'pi_package_version':json.loads((pathlib.Path(os.environ['FH_PI_PACKAGE'])/'package.json').read_text())['version'], 'pi_node_sha256':hashlib.sha256(pathlib.Path(os.environ['FH_PI_NODE']).read_bytes()).hexdigest(), 'model':'zai-glm/glm-5.3-flash', 'tasks':ids, 'concurrency':1, 'step_limit':0, 'development_policy':'No tests created or run for implementation QA; evaluated agents operate naturally inside isolated official task sandboxes', 'comparison':'all 30 task agent durations including failures; no speed verdict on missing/error/unproven/duplicate results', 'divergences':['GLM instead of published Kimi', 'fresh local Docker instead of Runta golden checkpoints', 'Pi DeepSWE uses same pinned package source entrypoint with HTTP forward-proxy adapter; stock Pi forces CONNECT which official offline policy forbids to the gateway']}
(root/f'runs/lb30-{sys.argv[1]}/provenance.json').write_text(json.dumps(provenance,indent=2))
for suite,prefix in [('terminal-bench','terminal-bench/'),('deepswe','datacurve/')]:
    tasks=[x.split('/',1)[1] for x in ids if x.startswith(prefix)]
    if len(tasks)!=(21 if suite=='terminal-bench' else 9): raise SystemExit('unexpected suite coverage')
    (root/f'runs/lb30-{sys.argv[1]}/{suite}.txt').write_text('\n'.join(tasks)+'\n')
PY
for arm in mini pi; do
  export FH_RUN_ID="lb30-$REP-$arm" FH_JOBS_DIR="jobs/lb30-$REP-$arm"
  [[ ! -e "$FH_JOBS_DIR" ]] || { echo "refusing to mix attempts in $FH_JOBS_DIR" >&2; exit 2; }
  if [[ "$arm" = pi ]]; then
    export FH_EXTRA_ARGS="--cpus limit --memory limit --override-cpus 2 --override-memory-mb 8192 --agent-kwarg version=1.1.0"
  else
    export FH_EXTRA_ARGS="--cpus limit --memory limit --override-cpus 2 --override-memory-mb 8192"
  fi
  FH_SUITE=terminal-bench FH_TASKS="runs/lb30-$REP/terminal-bench.txt" bash run-baseline.sh "$arm"
  while read -r task; do
    [[ -n "$task" ]] || continue
    if [[ "$arm" = mini ]]; then
      adapter=mini_agent_rs_pier:MiniAgentRs; model=rosetta/zai-glm/glm-5.3-flash
    else
      adapter=pi_agent_pier:PiAgent; model=openai/zai-glm/glm-5.3-flash
    fi
    pier run -p "deep-swe/tasks/$task" --agent-import-path "$adapter" --model "$model" \
      --jobs-dir "$FH_JOBS_DIR" -n 1 -k 1 -r 0 -y
  done < "runs/lb30-$REP/deepswe.txt"
  bash fh-guard.sh post
  python3 "$MINI_SOURCE/benchmark/frontier-harness/lb30_summary.py" benchmark.json "$FH_JOBS_DIR" > "runs/lb30-$REP/$arm-score.json"
done

python3 "$MINI_SOURCE/benchmark/frontier-harness/lb30_summary.py" benchmark.json "jobs/lb30-$REP-mini" --compare "jobs/lb30-$REP-pi" > "runs/lb30-$REP/comparison.json"
