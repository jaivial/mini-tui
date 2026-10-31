#!/bin/sh
# Request bytes, before vs after: every body two binaries send to the same scripted mock, diffed
# byte for byte. Runs use fixed directories and session ids and the mock's tool-call ids are
# deterministic, so nothing needs normalizing.
#   sh benchmark/footprint/wirediff.sh BASE_BIN NEW_BIN [OUT_DIR]
set -u
A=$1; B=$2; OUT=${3:-/tmp/mini-wirediff}
FP="$(dirname "$0")/footprint.py"
rm -rf "$OUT"; mkdir -p "$OUT"
status=0
scenario() {
  name=$1; shift
  mkdir -p "$OUT/$name"
  for side in a b; do
    bin=$A; [ $side = b ] && bin=$B
    python3 "$FP" --bin "$bin" --runs 2 --capture "$OUT/$name/$side" --json "$@" > "$OUT/$name/$side.summary" 2>&1 || true
  done
  n=$(find "$OUT/$name/a" -name 'req*.json' | wc -l)
  if diff -r "$OUT/$name/a" "$OUT/$name/b" > "$OUT/$name.diff"; then
    echo "$name: IDENTICAL ($n request bodies)"
  else
    echo "$name: DIFFER (see $OUT/$name.diff)"; status=1
  fi
}
mkdir -p "$OUT/empty-cache"
scenario cu-cached --steps 12 --sleep 0 --cu-call status
scenario cu-cold --steps 6 --sleep 0 --cu-call status --env XDG_CACHE_HOME="$OUT/empty-cache"
scenario no-cu --steps 12 --sleep 0 --no-cu
scenario long --steps 60 --lines 3000 --sleep 0
exit $status
