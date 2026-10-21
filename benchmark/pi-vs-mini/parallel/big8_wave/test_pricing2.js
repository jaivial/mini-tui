import assert from "assert";
import { tax, bulkDiscount } from "./pricing2.js";
assert.strictEqual(tax(105), 8, "8% of 105 floored = 8");
assert.strictEqual(tax(100), 8, "8% of 100 = 8");
assert.strictEqual(tax(-50), 0, "no tax on a negative amount");
assert.strictEqual(bulkDiscount(6), 0.9, "qty 6 gets the bulk discount");
assert.strictEqual(bulkDiscount(5), 1, "qty 5 pays full");
console.log("pricing2b tests PASS");
