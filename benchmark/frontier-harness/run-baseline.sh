#!/usr/bin/env bash
# Run one FrontierHarness Eval arm with Harbor + Docker.
#
#   bash run-baseline.sh mini     # mini-agent-rs (this repo's harness adapter)
#   bash run-baseline.sh pi       # published Pi baseline, same tasks/model/runtime
#   bash run-baseline.sh oracle   # environment sanity check (not a score)
#   FH_SUITE=deepswe bash run-baseline.sh mini   # the 9 DeepSWE tasks via pier
#
# Suite matters for the target: the 21 Terminal-Bench tasks top out at 19/30 (63.3 %)
# even if mini wins every contested one, because 6 of the 9 DeepSWE tasks are solved by
# almost nobody. Reaching 70 % (21/30) requires the DeepSWE suite, so a full run needs
# both suites.
#
# Every arm runs the identical task set, model and container runtime, so pass rates
# are comparable across arms. Divergences from the published protocol (local Docker
# instead of Runta golden checkpoints, non-Fireworks Kimi K3 route) are recorded in
# runs/<arm>/methodology.json and must be disclosed before quoting a number.
#
# Refuses to start while another session is running speed rounds on this machine
# (see ../mini-tui-benchmark/frontier_gate.sh): parallel load contaminates both
# wall-clock and pass-rate measurements. Override with FH_SKIP_GATE=1 only when you
# know the machine is idle.
set -euo pipefail

ARM=${1:-mini}
FH_ROOT=${FH_ROOT:-$HOME/frontier-harness-eval}
MODEL=${FH_MODEL:-opencode-go/kimi-k3}
RUN_ID=${FH_RUN_ID:-$(date -u +%Y-%m-%d)-$ARM}
JOBS_DIR=${FH_JOBS_DIR:-jobs/$RUN_ID}
OUT=${FH_OUT:-runs}
TASKS=${FH_TASKS:-tasks-subset.txt}
SUITE=${FH_SUITE:-terminal-bench}
CONCURRENCY=${FH_CONCURRENCY:-1}
AGENT_TIMEOUT=${FH_AGENT_TIMEOUT:-3600}

cd "$FH_ROOT"

if [ "${FH_SKIP_GATE:-0}" != "1" ] && [ -x "$HOME/mini-tui-benchmark/frontier_gate.sh" ]; then
  echo "==> contention gate"
  if ! bash "$HOME/mini-tui-benchmark/frontier_gate.sh" check; then
    echo "refusing to run a contaminated benchmark. wait, or set FH_SKIP_GATE=1 if idle." >&2
    exit 75
  fi
fi

case "$ARM" in
  mini)
    # Custom agent: Harbor accepts module:Class for anything not built in.
    export MINI_AGENT_RS_BIN=${MINI_AGENT_RS_BIN:-$HOME/.local/lib/mini-tui/mini-agent-rs}
    export MINI_AGENT_CONFIG_DIR=${MINI_AGENT_CONFIG_DIR:-$HOME/mini-tui/agent/src/minisweagent/config}
    export PYTHONPATH="$FH_ROOT/harness${PYTHONPATH:+:$PYTHONPATH}"
    # Kimi K3 through OpenCode Go; the x-opencode-session header is added by the binary.
    export OPENCODE_GO_API_KEY=${OPENCODE_GO_API_KEY:?set OPENCODE_GO_API_KEY}
    AGENT=mini_agent_rs:MiniAgentRs
    ;;
  pi)
    # Harbor resolves a provider from the model prefix ("opencode-go"), then looks the
    # key up in that provider's registered env names. opencode-go is not a registered
    # provider, so resolution found no key at all and pi would have run unauthenticated:
    # pi's own PI_API_KEY/PI_BASE_URL exports are never consulted. Routing the model
    # through the registered openai provider and naming the gateway in OPENAI_* is what
    # actually hands pi its key and endpoint; pi also needs model_api to accept a
    # custom base URL, otherwise it refuses the endpoint outright.
    export OPENAI_API_KEY=${PI_API_KEY:-${OPENCODE_GO_API_KEY:?set a key for pi}}
    export OPENAI_BASE_URL=${PI_BASE_URL:-https://opencode.ai/zen/go/v1}
    MODEL=${FH_PI_MODEL:-openai/kimi-k3}
    export OPENCODE_GO_API_KEY=${OPENCODE_GO_API_KEY:-}
    export FH_EXTRA_ARGS="${FH_EXTRA_ARGS:-} --agent-kwarg model_api=openai-responses"
    AGENT=pi
    ;;
  oracle)
    AGENT=oracle
    ;;
  *)
    echo "unknown arm: $ARM (expected mini|pi|oracle)" >&2; exit 2 ;;
esac

mkdir -p "$OUT/$RUN_ID"
cat > "$OUT/$RUN_ID/methodology.json" <<JSON
{
  "arm": "$ARM",
  "suite": "$SUITE",
  "agent": "$AGENT",
  "model": "$MODEL",
  "model_provider": "${FH_MODEL_PROVIDER:-opencode-go}",
  "dataset": "$( [ "$SUITE" = deepswe ] && echo 'datacurve-ai/deep-swe@435ee89e' || echo 'terminal-bench@2.0' )",
  "tasks_file": "$TASKS",
  "runtime": "local docker (host $(hostname))",
  "concurrency": $CONCURRENCY,
  "divergences_from_published_protocol": [
    "Runta golden-checkpoint restores replaced by fresh docker containers per trial; no shared frozen checkpoint, so disk/cache state is not guaranteed identical across arms",
    "Kimi K3 served via OpenCode Go rather than Fireworks; the skill requires a matched control run before claiming leaderboard comparability",
    "DeepSWE tasks normally run on a Runta-hosted runtime because they set allow_internet=false and the agent must still reach its provider"
  ],
  "scored_by": "the harness accounting rules (reward>=1 plus observed usage = success)"
}
JSON

echo "==> arm=$ARM suite=$SUITE agent=$AGENT model=$MODEL tasks=$TASKS"

# DeepSWE goes through pier, not harbor: pier adds a per-agent network allowlist so the
# agent reaches its provider while the task environment stays offline, which is what
# these tasks require. Harbor blocks all outbound traffic on them, including LLM calls.
if [ "$SUITE" = "deepswe" ]; then
  export PATH="$HOME/.local/bin:$PATH"
  test -d deep-swe/tasks || { echo "deep-swe corpus missing; run with INSTALL_PIER=1 bash setup-fh-mini.sh" >&2; exit 2; }
  # Pier takes the agent as a name or an import path, unlike harbor's -a. Only mini is
  # reachable as a custom import path; pier has no built-in pi agent, so the pi control
  # needs its Harbor adapter path here or it would silently re-run mini (and a
  # "control" that is the treatment is worse than no control at all).
  case "$AGENT" in
    pi)
      command -v pi >/dev/null 2>&1 || { echo "pier cannot run the pi arm: no built-in pi agent and no 'pi' on PATH" >&2; exit 2; }
      PIER_AGENT_ARGS=(--agent pi)
      ;;
    oracle)
      PIER_AGENT_ARGS=(--agent oracle)
      ;;
    *)
      PIER_AGENT_ARGS=(--agent-import-path "$AGENT")
      ;;
  esac
  set -x
  while read -r task; do
    [ -n "$task" ] || continue
    pier run -p "deep-swe/tasks/$task" \
      "${PIER_AGENT_ARGS[@]}" \
      --model "$MODEL" --jobs-dir "$JOBS_DIR"
  done < "$TASKS"
  set +x
  echo "==> evidence: $JOBS_DIR"
  exit 0
fi
set -x
.tools/hbenv/bin/harbor run \
  -d terminal-bench@2.0 \
  $(while read -r t; do [ -n "$t" ] && printf -- '-i\n%s\n' "$t"; done < "$TASKS") \
  -a "$AGENT" \
  -m "$MODEL" \
  -o "$JOBS_DIR" \
  -n "$CONCURRENCY" \
  -k 1 \
  -y \
  ${FH_EXTRA_ARGS:-}
set +x

echo "==> evidence: $JOBS_DIR"
echo "==> score it with the benchmark's own accounting:"
echo "    node skills/frontierharness-eval/scripts/normalize-results.mjs --run $OUT/$RUN_ID --label \"$ARM\""