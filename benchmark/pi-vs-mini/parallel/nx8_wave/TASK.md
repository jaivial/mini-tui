# Task: eight independent work items (in parallel)

Eight independent parts in eight directories; each has its own SPEC.md,
inputs and tests, and touches nothing outside its directory. The parts share
no tooling or domain, so they can run in parallel. For each part, follow its
SPEC.md exactly and make its own check pass.

1. `part1_tokenizer/` — implement `tokenize` in `tokenizer.js` per its SPEC.md.
   Check: `node part1_tokenizer/test_tokenizer.js`.
2. `part2_tinydb/` — implement `TinyDB` in `tinydb.py` per its SPEC.md.
   Check: `python3 part2_tinydb/test_tinydb.py`.
3. `part3_router/` — exactly three wrong behaviors in `match.js`/`router.js`.
   Check: `node part3_router/test_router.js`.
4. `part4_expr/` — exactly three wrong behaviors in `parser.py`.
   Check: `python3 part4_expr/test_parser.py`.
5. `part5_insights/` — compute `part5_insights/insights.json` from the three
   CSVs per its SPEC.md. Check: `python3 part5_insights/verify_part5.py`.
6. `part6_logtool/` — implement the `logtool.py` CLI per its SPEC.md.
   Check: `python3 part6_logtool/test_logtool.py`.
7. `part7_scheduler/` — implement `best_schedule` in `scheduler.py` per its
   SPEC.md. Check: `python3 part7_scheduler/test_scheduler.py`.
8. `part8_refactor/` — refactor `messy.js` per its SPEC.md without changing
   behavior, and write `part8_refactor/REFACTOR.md` as specified.
   Check: `node part8_refactor/test_messy.js` (must still pass) plus the
   REFACTOR.md markers.

Work only inside the part directories; the root of this task is just the list.
