import assert from "assert";
import { match } from "./match.js";
import { Router } from "./router.js";

assert.deepStrictEqual(match("/a/:id", "/a/7"), { id: "7" });
assert.deepStrictEqual(match("/a/:id", "/a"), null, "missing segment is not a match");
assert.deepStrictEqual(match("/f/*rest", "/f/x/y"), { rest: "x/y" });
assert.deepStrictEqual(match("/f/*rest", "/f"), { rest: "" }, "wildcard can be empty");
assert.deepStrictEqual(match("/a/b", "/a/b/c"), null, "extra segments are not a match");

const r = new Router();
r.add("GET", "/u/:id", (p) => `user ${p.id}`);
r.add("POST", "/u/:id", (p) => `created ${p.id}`);
r.add("GET", "/f/*rest", (p) => `file ${p.rest}`);
assert.strictEqual(r.handle("GET", "/u/5"), "user 5");
assert.strictEqual(r.handle("POST", "/u/5"), "created 5", "method matters");
assert.strictEqual(r.handle("GET", "/f/a/b.txt"), "file a/b.txt");
assert.strictEqual(r.handle("GET", "/nope"), "404");
console.log("part3 router PASS");
