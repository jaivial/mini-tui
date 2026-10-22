import assert from "assert";
import { createMachine } from "./fsm.js";

const log = [];
const m = createMachine({
  initial: "idle",
  states: {
    idle: { on: { START: "run" }, onEnter: (to, from, ev) => log.push(`enter:${to}:${from ?? "-"}:${ev ?? "-"}`) },
    run: {
      on: { STOP: "idle", SKIP: ["done", (p) => p && p.ok !== false] },
      onExit: (to, from) => log.push(`exit:${from}->${to}`),
    },
    done: { on: {} },
  },
});
assert.strictEqual(m.state, "idle");
assert.strictEqual(m.send("START"), "run");
assert.strictEqual(m.state, "run");
assert.strictEqual(m.send("STOP"), "idle");
assert.deepStrictEqual(m.history(), ["idle", "run", "idle"]);
assert.strictEqual(m.send("NOPE"), "idle", "unknown type is a no-op");
assert.strictEqual(m.send("SKIP"), "idle", "SKIP is not defined on idle");
assert.strictEqual(m.send("START"), "run");
assert.strictEqual(m.send("SKIP", { ok: false }), "run", "guard falsy blocks the transition");
assert.strictEqual(m.send("SKIP", { ok: true }), "done");
assert.deepStrictEqual(log, ["enter:idle:-:-", "exit:run->idle", "enter:idle:run:STOP", "exit:run->done"], "hook order and args");
console.log("part3 fsm PASS");
