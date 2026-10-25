#!/usr/bin/env bash
# mini queue vs pi, both on Kimi for Coding K3, using their existing credentials.
set -euo pipefail
export BENCH_MODEL=${BENCH_MODEL:-kimi-coding/k3}
export BENCH_PI_PROVIDER=${BENCH_PI_PROVIDER:-kimi-coding}
export BENCH_PI_MODEL=${BENCH_PI_MODEL:-k3}
export RUN_ROOT_PREFIX=${RUN_ROOT_PREFIX:-kimi-k3}
exec bash "$(dirname "$0")/run_mimo_queue_ab.sh" "$@"
