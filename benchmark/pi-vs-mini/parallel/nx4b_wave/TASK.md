# Task: four independent projects (in parallel)

Four independent projects in four directories, each with its own SPEC.md and
its own test suite. The tests define the exact behavior and currently FAIL:
fix or implement the source until each suite passes. The projects share no
domain or tooling, so the parts can run in parallel.

1. `part1_strkit/` — `node part1_strkit/test_strkit.js`
2. `part2_tpl/` — `python3 part2_tpl/test_tpl.py`
3. `part3_fsm/` — `node part3_fsm/test_fsm.js`
4. `part4_statkit/` — `python3 part4_statkit/test_statkit.py`

Do not change any test file. Work only inside the part directories.
