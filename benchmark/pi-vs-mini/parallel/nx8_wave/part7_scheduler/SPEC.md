# Part 7 — scheduler (Python)

Implement `best_schedule(jobs)` in `scheduler.py`. Each job is a dict
`{"name", "start", "end", "weight"}` (integers, `end` exclusive). Choose the set
of non-overlapping jobs with the maximum total weight (weighted interval
scheduling). Return its jobs sorted by `start`, then `name`. Equal weight sums:
prefer the lexicographically smallest list of names.

`python3 test_scheduler.py` must pass. Do not change the test.
