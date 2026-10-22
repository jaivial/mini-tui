# Part 6 — logtool (Python CLI)

Implement `logtool.py`, a CLI over log lines `ts LEVEL service msg...`:

- `python3 logtool.py count FILE` -> total lines
- `python3 logtool.py errors FILE` -> number of ERROR lines
- `python3 logtool.py top FILE N` -> the N services with the most lines,
  most first, one per line (ties: alphabetically first)
- `python3 logtool.py rate FILE` -> ERROR rate with 4 decimals (errors/lines)
- `python3 logtool.py slow FILE MS` -> lines whose msg starts with "took " and
  whose number of ms is greater than MS, one per line
- `python3 logtool.py filter FILE LEVEL` -> lines at that level, one per line

`python3 test_logtool.py` must pass. Do not change the test.
