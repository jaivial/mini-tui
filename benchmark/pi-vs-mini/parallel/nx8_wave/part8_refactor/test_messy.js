import assert from "assert";
import { f1, f2, f3, combine } from "./messy.js";
assert.strictEqual(f1(0.5), 50);
assert.strictEqual(f1(-1), 0);
assert.strictEqual(f2(200), 100);
assert.strictEqual(f3(NaN), 0);
assert.strictEqual(f3(-3), 0);
assert.strictEqual(combine(0.2, 10), 35);
console.log("part8 behavior PASS");
