import assert from "assert";
import { shipping, handling } from "./pricing.js";
assert.strictEqual(shipping(10000), 0, ">= 10000 ships free");
assert.strictEqual(shipping(-5), 750, "the flat fee is 750 regardless of the subtotal");
assert.strictEqual(shipping(9999), 750, "below 10000 pays flat");
assert.strictEqual(handling(20), 0, "20 items: no handling");
assert.strictEqual(handling(21), 1050, "21 items: 50 per item");
console.log("pricing2 tests PASS");
