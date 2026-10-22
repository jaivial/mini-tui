import assert from "assert";
import { tokenize } from "./tokenizer.js";
assert.deepStrictEqual(tokenize("ab + 12"), [
  { type: "ident", value: "ab" }, { type: "op", value: "+" }, { type: "num", value: 12 },
]);
assert.deepStrictEqual(tokenize('x = "hi there"'), [
  { type: "ident", value: "x" }, { type: "op", value: "=" }, { type: "str", value: "hi there" },
]);
assert.deepStrictEqual(tokenize("  "), []);
assert.deepStrictEqual(tokenize("(1+2)*z"), [
  { type: "op", value: "(" }, { type: "num", value: 1 }, { type: "op", value: "+" },
  { type: "num", value: 2 }, { type: "op", value: ")" }, { type: "op", value: "*" },
  { type: "ident", value: "z" },
]);
assert.throws(() => tokenize("a # b"), /unexpected char: #/);
assert.deepStrictEqual(tokenize("_x9"), [{ type: "ident", value: "_x9" }]);
console.log("part1 tokenizer PASS");
