/**
 * The hosts panel's "Test" button: state that only failed in the browser.
 *
 * The defect these pin was measured against the DEPLOYED build, not reasoned about. The panel
 * kept its verdicts in a plain `Record` and cleared one with `new Map(record)`, which throws
 * `TypeError: object is not iterable` — and it threw BEFORE the `try`, so the `catch` never saw
 * it. What a user got: the button switched to "Testing" and stayed there, and no request ever
 * left the browser. Measured with CDP network events: **zero** requests for the click, at every
 * sampling point out to 28 s. The server-side fix was correct and the button still did nothing.
 *
 * A test that only checked the server would have passed straight through this, which is why the
 * rules live in a module without Svelte in it.
 */
import { describe, expect, test } from "bun:test";
import { isCancel, withVerdict, withoutVerdict } from "../web/src/lib/probeState";

describe("withoutVerdict", () => {
  test("drops one host and keeps the others", () => {
    const results = {
      a: { ok: true, message: "connected · 1.0" },
      b: { ok: false, message: "boom" },
    };
    expect(withoutVerdict(results, "a")).toEqual({ b: { ok: false, message: "boom" } });
    expect(Object.keys(withoutVerdict(results, "a"))).toEqual(["b"]);
  });

  test("does not mutate the object it was given", () => {
    const results = { a: { ok: true, message: "x" } };
    const next = withoutVerdict(results, "a");
    expect(results.a).toEqual({ ok: true, message: "x" });
    expect(next).not.toBe(results);
  });

  test("dropping an absent host is a no-op, not a throw", () => {
    expect(withoutVerdict({}, "nope")).toEqual({});
    expect(withoutVerdict({ a: { ok: true, message: "x" } }, "nope")).toEqual({
      a: { ok: true, message: "x" },
    });
  });

  test("THE REGRESSION: it must not be built with new Map", () => {
    // This is the exact call that shipped: a plain Record is not iterable, so
    // `new Map(record)` throws before the try block and the request never goes out.
    const results = { a: { ok: true, message: "x" } };
    // Typed as the loose shape so the compiler cannot flag the very call under test.
    const asIterable = results as unknown as Iterable<[string, unknown]>;
    expect(() => new Map(asIterable)).toThrow();
    // The replacement has to survive the same input.
    expect(() => withoutVerdict(results, "a")).not.toThrow();
  });

  test("a host id that looks like a Map key is still just a string", () => {
    const results = { size: { ok: true, message: "x" }, other: { ok: false, message: "y" } };
    // `new Map` would read `results.size` as a count and silently lose it.
    expect(withoutVerdict(results, "size")).toEqual({ other: { ok: false, message: "y" } });
  });
});

describe("withVerdict", () => {
  test("records without touching the rest", () => {
    const results = { a: { ok: false, message: "old" } };
    const next = withVerdict(results, "a", { ok: true, message: "new" });
    expect(next.a).toEqual({ ok: true, message: "new" });
    expect(results.a).toEqual({ ok: false, message: "old" });
  });
});

describe("isCancel", () => {
  test("an abort is a cancel, not a failed host", () => {
    const abort = new Error("The operation was aborted.");
    abort.name = "AbortError";
    expect(isCancel(abort)).toBe(true);
  });

  test("a real failure is not swallowed as a cancel", () => {
    // Otherwise the button stays disabled forever and never reports the host.
    expect(isCancel(new Error("network down"))).toBe(false);
    expect(isCancel({ name: "TypeError" })).toBe(false);
    expect(isCancel(null)).toBe(false);
    expect(isCancel("AbortError")).toBe(false);
  });
});
