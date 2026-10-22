# Part 3 — finite state machine (JS)

Make `node test_fsm.js` pass. `fsm.js` exports `createMachine(spec)`:

- `spec = { initial, states: { name: { on: { EVENT: target }, onEnter?, onExit? } } }`
- `machine.state` — the current state name
- `machine.send(type, payload)` — runs the current state's `onExit(next, prev)`,
  moves, runs `onEnter(next, prev, type)`, returns the new state name. The
  initial state's `onEnter(initial, undefined, undefined)` runs at creation.
  An unknown type or a state without that transition is a no-op returning the
  current state (no hooks fire).
- `machine.history()` — the visited state names including the initial one.
- Guards: a transition value may be `[target, guardFn]`; when `guardFn(payload)`
  is falsy the transition does not fire (a no-op, no hooks).

Do not change the test.
