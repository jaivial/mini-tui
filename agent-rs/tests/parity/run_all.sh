#!/bin/sh
# Every parity scenario: the Python agent and the Rust agent must write identical trajectories.
cd "$(dirname "$0")/.." || exit 1
PY=/usr/bin/python3.10
fail=0
run() {
  name=$1; shift
  printf '%-16s ' "$name"
  out=$(timeout 60 $PY parity/compare.py "$@" 2>&1)
  echo "$out" | tail -n +1 | head -1
  if ! echo "$out" | grep -q '^IDENTICAL'; then fail=1; echo "$out" | sed -n '2,12p'; fi
}
run basic          parity/basic.yaml
run limits         parity/format_errors.yaml
run submit-timeout parity/submit_marker.yaml
run text-model     parity/textmodel.yaml
run cost-limit     parity/cost_limit.yaml
run resume         parity/resume.yaml --resume "$PWD/parity/resume_src.json" --task "continue please"
run followup       parity/followup.yaml --control-script parity/followup.control
run compact        parity/compact.yaml --control-script parity/compact.control
run sigint         parity/sigint.yaml --control-script parity/sigint.control
printf 'WAIT_JOURNAL 2\nSLEEP 1.0\nKILL\n' > /tmp/parity-term.control
run sigterm        parity/sigint.yaml --control-script /tmp/parity-term.control
run model-switch   parity/model_switch.yaml --control-script parity/model_switch.control
run sleep-sigint   parity/sleepmodel.yaml --control-script parity/sleepmodel.control
run compact-only   parity/resume.yaml --resume "$PWD/parity/resume_long.json" --task "" --compact-only
# The shipped configs, with a scripted model swapped in (the templates are what matters).
run mini.yaml      ../../agent/src/minisweagent/config/mini.yaml --extra-config parity/script_answer.yaml
# The HTTP clients against a scripted server: trajectories and every request body must match.
wire() {
  name=$1; shift
  printf '%-16s ' "$name"
  out=$(timeout 60 $PY parity/compare_wire.py "$@" 2>/dev/null)
  echo "$out" | head -1
  if ! echo "$out" | grep -q '^IDENTICAL'; then fail=1; echo "$out" | sed -n '2,12p'; fi
}
wire cliproxy-sse    parity/wire_chat.yaml parity/wire_chat.json --base-env CLIPROXY_API_BASE
wire rosetta         parity/wire_rosetta.yaml parity/wire_chat.json --base-env ROSETTA_API_BASE
wire deepseek-alias  parity/wire_deepseek.yaml parity/wire_chat.json --base-env DEEPSEEK_API_BASE --key-env DEEPSEEK_API_KEY
wire zai-registry    parity/wire_zai.yaml parity/wire_chat.json --base-env ZAI_API_BASE --key-env ZAI_API_KEY
wire openai-temp     parity/wire_openai.yaml parity/wire_openai.json --base-env MSWEA_OPENAI_API_BASE --key-env MSWEA_OPENAI_API_KEY
wire anthropic       parity/wire_messages.yaml parity/wire_messages.json --base-env ANTHROPIC_API_BASE --key-env ANTHROPIC_API_KEY
wire responses       parity/wire_responses.yaml parity/wire_responses.json --base-env MSWEA_OPENAI_API_BASE --key-env MSWEA_OPENAI_API_KEY
wire abort-401       parity/wire_abort.yaml parity/wire_abort.json --base-env DEEPSEEK_API_BASE --key-env DEEPSEEK_API_KEY
wire go-chat         parity/wire_go_chat.yaml parity/wire_go_chat.json --base-env OPENCODE_GO_API_BASE --key-env OPENCODE_GO_API_KEY
wire go-messages     parity/wire_go_messages.yaml parity/wire_go_messages.json --base-env OPENCODE_GO_API_BASE --key-env OPENCODE_GO_API_KEY
wire go-responses    parity/wire_go_responses.yaml parity/wire_go_responses.json --base-env OPENCODE_GO_API_BASE --key-env OPENCODE_GO_API_KEY
for p in $(ps -eo pid,ppid,args | awk '$2==1 && $3=="/bin/sh" && $5=="sleep" && $6=="20" {print $1}'); do kill "$p"; done
[ $fail = 0 ] && echo "ALL IDENTICAL" || { echo "SOME DIFFER"; exit 1; }
