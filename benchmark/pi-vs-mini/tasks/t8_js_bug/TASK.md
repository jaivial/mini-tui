# Task: fix the concurrency limiter

`limiter.js` exports a `Limiter` used to cap concurrent async work. Its slot
accounting is broken: `release()` decrements `active` even when a waiter is
handed the slot, so `active` can go negative and later calls stop being capped
(`node --test limiter.test.js` fails today).

Fix `limiter.js` (not the tests) so all three tests pass:

- concurrency never exceeds `max`;
- `release()` passes the slot to exactly one waiter and `active` stays within
  `[0, max]`;
- a limiter reused after an over-release still caps concurrency.

Verify with `node --test limiter.test.js`. Work only in the current directory.
