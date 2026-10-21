#!/bin/bash
# The fixed cart.js must implement: >=200 -> 10%, >=100 -> 5%, else 0 (tiers by threshold, highest first)
cd "$(dirname "$0")"
node _check.mjs "$PWD" 2>&1 | tail -2
