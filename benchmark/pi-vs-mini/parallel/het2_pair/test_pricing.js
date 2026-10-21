import assert from "assert";

import { price } from "./pricing.js";

// The spec: 15% off at qty >= 10, 5% off at qty >= 5, rounded to cents.
assert.strictEqual(price(10, 10), 85, "qty 10 must get the 15% discount");
assert.strictEqual(price(10, 12), 102, "qty 12 must get the 15% discount");
assert.strictEqual(price(10, 5), 47.5, "qty 5 must get the 5% discount");
assert.strictEqual(price(10, 4), 40, "qty 4 gets no discount");
assert.strictEqual(price(0.333, 1), 0.33, "rounded to cents");
console.log("pricing tests PASS");
