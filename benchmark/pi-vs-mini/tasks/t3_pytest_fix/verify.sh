#!/bin/bash
cd "$(dirname "$0")"
python3 -m pytest -q test_t3.py >/dev/null 2>&1 && { echo PASS; exit 0; }
echo FAIL; exit 1
