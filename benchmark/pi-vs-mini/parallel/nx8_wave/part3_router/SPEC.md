# Part 3 — router bug hunt (JS)

`router.js` + `match.js` implement a tiny HTTP router:

- `match(pattern, path)` — `:name` captures one segment, `*rest` captures the
  rest (as a string, possibly empty). Returns the params object or `null`.
- `Router` — `add(method, pattern, handler)`, `handle(method, path)` returns
  the handler's result with params merged, or `404` when nothing matches.

Exactly THREE behaviors are wrong against that spec. Fix the implementation
so `node test_router.js` passes. Do not change the test.
