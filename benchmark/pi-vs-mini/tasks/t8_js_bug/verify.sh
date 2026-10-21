#!/bin/bash
cd "$(dirname "$0")"
node --test limiter.test.js >/dev/null 2>&1 && { echo PASS; exit 0; }
echo FAIL; exit 1
