#!/bin/bash
cd "$(dirname "$0")"
bad=0
check() { local label=$1 part=$2; shift 2
  if ! (cd "$part" && "$@") >/tmp/nx4b-out.txt 2>&1; then echo "FAIL: $label"; tail -3 /tmp/nx4b-out.txt; bad=1; fi; }
check "part1 strkit"   part1_strkit node test_strkit.js
check "part2 tpl"      part2_tpl python3 test_tpl.py
check "part3 fsm"      part3_fsm node test_fsm.js
check "part4 statkit"  part4_statkit python3 test_statkit.py
if [ $bad -eq 0 ]; then echo "PASS"; else echo "FAIL"; exit 1; fi
