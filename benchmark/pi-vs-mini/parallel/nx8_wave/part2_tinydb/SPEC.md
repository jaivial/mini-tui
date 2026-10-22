# Part 2 — tinydb (Python)

Implement `TinyDB` in `tinydb.py`:

- `TinyDB(clock)` — `clock` is a callable returning the current unix time.
- `set(key, value, ttl=None)` — store; `ttl` is seconds of life from `clock()`.
- `get(key)` — the value, or `None` when missing OR expired (an expired key
  must also be removed on read).
- `delete(key)` — remove; returns True if something was removed.
- `keys()` — the sorted list of live keys.
- `cleanup()` — drop every expired key; returns how many were dropped.

`python3 test_tinydb.py` must pass. Do not change the test.
