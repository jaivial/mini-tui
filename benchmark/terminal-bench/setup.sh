#!/usr/bin/env bash
# One-shot, idempotent setup for running Terminal-Bench against mini-agent-rs (mini-tui).
#
# Everything heavy lands OUTSIDE the git worktree, under $BENCH_ROOT (a session
# directory): a python venv with Harbor, ~600 MB of task sources and the docker images
# they reference do not belong in a commit. What this repo keeps is the adapter
# (mini_agent_rs.py), the runner, the receipt template and the analysis doc.
#
#   bash benchmark/terminal-bench/setup.sh
#
# Knobs (env):
#   BENCH_ROOT   where the venv + datasets live   (default ~/orq/mc18-bughunt/bench)
#   DATASETS     datasets to download, space separated
#                (default: terminal-bench-sample@2.0 terminal-bench@2.0)
#   SKIP_BUILD=1 skip the cargo build of mini-agent-rs
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}
BENCH_ROOT=${BENCH_ROOT:-$HOME/orq/mc18-bughunt/bench}
HARBOR_PIN=${HARBOR_PIN:-0.24.0}
DATASETS=${DATASETS:-"terminal-bench-sample@2.0 terminal-bench@2.0"}
VENV="$BENCH_ROOT/hbenv"

echo "==> repo:      $REPO_ROOT"
echo "==> bench dir: $BENCH_ROOT"

mkdir -p "$BENCH_ROOT"

echo "==> harbor $HARBOR_PIN in $VENV (python 3.12 via uv)"
if [ ! -x "$VENV/bin/harbor" ]; then
  uv venv --python 3.12 "$VENV"
  uv pip install --python "$VENV/bin/python" "harbor==$HARBOR_PIN"
fi
"$VENV/bin/harbor" --version

echo "==> datasets: $DATASETS"
# Downloads are wrapped in the same scope as the build: nothing long-running in
# this repo runs unbounded, and systemd-run failing must stop the setup instead of
# silently falling back to a naked build.
scoped() { systemd-run --user --scope -p CPUQuota=200% -p MemoryMax=6G "$@"; }
for ds in $DATASETS; do
  scoped "$VENV/bin/harbor" download "$ds" -o "$BENCH_ROOT/dataset"
done
echo "    task dirs now under $BENCH_ROOT/dataset:"
for d in "$BENCH_ROOT/dataset"/*/; do
  printf '      %-40s %s tasks\n' "$(basename "$d")" "$(find "$d" -mindepth 1 -maxdepth 1 -type d | wc -l)"
done

echo "==> mini-agent-rs (static musl build, the binary the adapter installs)"
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  scoped bash -c "cd '$REPO_ROOT/agent-rs' && cargo build --release --target x86_64-unknown-linux-musl" \
    || { echo "scoped build failed (no systemd --user session, or a cargo error above)." >&2
         echo "Run the build yourself under systemd-run --scope -p CPUQuota=200% -p MemoryMax=6G" >&2
         echo "(SKIP_BUILD=1 skips this step) and re-run setup.sh." >&2
         exit 1; }
fi
BIN="$REPO_ROOT/agent-rs/target/x86_64-unknown-linux-musl/release/mini-agent-rs"
test -x "$BIN" || { echo "missing $BIN" >&2; exit 1; }
echo "    $BIN"
echo "    $(sha256sum "$BIN" | cut -c1-20)…"

echo "==> provenance -> $BENCH_ROOT/setup-provenance.json"
cat > "$BENCH_ROOT/setup-provenance.json" <<JSON
{
  "repo_commit": "$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)",
  "harbor": "$HARBOR_PIN",
  "datasets": "$DATASETS",
  "mini_agent_rs_sha256": "$(sha256sum "$BIN" | cut -d' ' -f1)",
  "built_at_utc": "$(date -u +%FT%TZ)"
}
JSON
cat "$BENCH_ROOT/setup-provenance.json"

echo
echo "setup complete. next: bash benchmark/terminal-bench/run_pilot.sh"
