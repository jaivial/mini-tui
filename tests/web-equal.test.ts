/** The one-level comparison the session store uses to skip a render it does not need. */
import { describe, expect, test } from "bun:test";
import { shallowEqual } from "../web/src/lib/equal";

describe("shallowEqual", () => {
  test("same reference is equal without looking inside", () => {
    const a = { id: "s", events: [] };
    expect(shallowEqual(a, a)).toBe(true);
  });
  test("same flat fields are equal", () => {
    expect(shallowEqual({ id: "s", status: "running", cost: 0.1 }, { id: "s", status: "running", cost: 0.1 })).toBe(true);
  });
  test("a changed field is not", () => {
    expect(shallowEqual({ id: "s", status: "running" }, { id: "s", status: "idle" })).toBe(false);
  });
  test("an array replaced by an equal-looking one is not (the transcript was rebuilt)", () => {
    expect(shallowEqual({ events: [1, 2] }, { events: [1, 2] })).toBe(false);
  });
  test("a field gained or lost is not", () => {
    expect(shallowEqual({ id: "s" }, { id: "s", partial: undefined })).toBe(false);
    expect(shallowEqual({ id: "s", extra: 1 }, { id: "s" })).toBe(false);
  });
  test("null, primitives and missing values", () => {
    expect(shallowEqual(null, null)).toBe(true);
    expect(shallowEqual(null, {})).toBe(false);
    expect(shallowEqual(1, 1)).toBe(true);
    expect(shallowEqual("a", "a")).toBe(true);
    expect(shallowEqual("a", "b")).toBe(false);
    expect(shallowEqual(undefined, null)).toBe(false);
  });
});
