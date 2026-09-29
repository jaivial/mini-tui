/** The pane tree: splitting, closing, resizing, reading order and restoring a saved layout. */
import { describe, expect, test } from "bun:test";
import { MAX_PANES, clampRatio, count, leaves, neighbour, remove, restore, roomToSplit, setRatio, sizeOf, split, type Node } from "../web/src/lib/panes";

const one: Node = { kind: "pane", id: "p1" };

describe("split", () => {
  test("the split pane keeps its place; the new one opens right of it (row) or below it (col)", () => {
    const t = split(one, "p1", "row", "p2", "s1");
    expect(t).toEqual({ kind: "split", id: "s1", dir: "row", ratio: 0.5, a: one, b: { kind: "pane", id: "p2" } });
    const t2 = split(t, "p2", "col", "p3", "s2");
    expect(leaves(t2)).toEqual(["p1", "p2", "p3"]);
    expect((t2 as any).b).toMatchObject({ dir: "col", a: { id: "p2" }, b: { id: "p3" } });
  });
  test("splitting a pane that is not there changes nothing (same object)", () => {
    const t = split(one, "p1", "row", "p2", "s1");
    expect(split(t, "nope", "row", "p9", "s9")).toBe(t);
  });
  test("reading order is left to right, then top to bottom, however deep", () => {
    let t: Node = one;
    t = split(t, "p1", "row", "p2", "s1"); // p1 | p2
    t = split(t, "p1", "col", "p3", "s2"); // (p1 / p3) | p2
    t = split(t, "p2", "col", "p4", "s3"); // (p1 / p3) | (p2 / p4)
    expect(leaves(t)).toEqual(["p1", "p3", "p2", "p4"]);
    expect(count(t)).toBe(4);
  });
});

describe("remove", () => {
  test("the sibling takes the whole area, and nesting collapses cleanly", () => {
    let t: Node = split(one, "p1", "row", "p2", "s1");
    t = split(t, "p2", "col", "p3", "s2");
    const after = remove(t, "p2");
    expect(after).toEqual({ kind: "split", id: "s1", dir: "row", ratio: 0.5, a: one, b: { kind: "pane", id: "p3" } });
    expect(remove(remove(after, "p3"), "p1")).toEqual(one); // the last pane stays
  });
  test("focus moves to the pane before the closed one, or after it when it was first", () => {
    let t: Node = split(one, "p1", "row", "p2", "s1");
    t = split(t, "p2", "row", "p3", "s2");
    expect(neighbour(t, "p2")).toBe("p1");
    expect(neighbour(t, "p1")).toBe("p2");
    expect(neighbour(one, "p1")).toBeNull();
    expect(neighbour(t, "zz")).toBeNull();
  });
});

describe("resize", () => {
  test("a ratio is clamped so neither side can be dragged away to nothing", () => {
    const t = split(one, "p1", "row", "p2", "s1");
    expect((setRatio(t, "s1", 0.7) as any).ratio).toBe(0.7);
    expect((setRatio(t, "s1", 0.01) as any).ratio).toBe(0.15);
    expect((setRatio(t, "s1", 5) as any).ratio).toBe(0.85);
    expect(clampRatio(Number.NaN)).toBe(0.5);
  });
  test("a pane's size follows every split above it", () => {
    let t: Node = split(one, "p1", "row", "p2", "s1");
    t = setRatio(t, "s1", 0.25);
    t = split(t, "p2", "col", "p3", "s2");
    expect(sizeOf(t, "p1", 1200, 800)).toEqual({ w: 300, h: 800 });
    expect(sizeOf(t, "p3", 1200, 800)).toEqual({ w: 900, h: 400 });
  });
  test("a split is refused when either half would be too small to use", () => {
    const min = { w: 360, h: 260 };
    expect(roomToSplit(one, "p1", "row", 1280, 800, min)).toBe(true);
    expect(roomToSplit(one, "p1", "row", 700, 800, min)).toBe(false);
    expect(roomToSplit(one, "p1", "col", 1280, 500, min)).toBe(false);
    const t = split(one, "p1", "row", "p2", "s1");
    expect(roomToSplit(t, "p2", "row", 1280, 800, min)).toBe(false); // p2 is 640 wide: halves of 320
    expect(roomToSplit(t, "missing", "row", 1280, 800, min)).toBe(false);
  });
});

describe("restore", () => {
  test("a saved layout comes back as it was", () => {
    let t: Node = split(one, "p1", "row", "p2", "s1");
    t = split(t, "p2", "col", "p3", "s2");
    t = setRatio(t, "s1", 0.3);
    expect(restore(JSON.parse(JSON.stringify(t)))).toEqual(t);
  });
  test("anything malformed is refused whole, never half-rendered", () => {
    expect(restore(null)).toBeNull();
    expect(restore("p1")).toBeNull();
    expect(restore({ kind: "pane" })).toBeNull(); // no id
    expect(restore({ kind: "pane", id: "../x" })).toBeNull();
    expect(restore({ kind: "window", id: "w" })).toBeNull();
    expect(restore({ kind: "split", id: "s", dir: "diagonal", ratio: 0.5, a: one, b: { kind: "pane", id: "p2" } })).toBeNull();
    expect(restore({ kind: "split", id: "s", dir: "row", ratio: 0.5, a: one, b: one })).toBeNull(); // duplicate id
    expect(restore({ kind: "split", id: "s", dir: "row", ratio: 0.5, a: one })).toBeNull(); // missing side
  });
  test("a bad ratio is repaired rather than trusted", () => {
    const t = restore({ kind: "split", id: "s", dir: "row", ratio: 99, a: one, b: { kind: "pane", id: "p2" } });
    expect((t as any).ratio).toBe(0.85);
  });
  test("more panes than the limit, or an absurdly deep tree, is refused", () => {
    let t: Node = one;
    for (let i = 2; i <= MAX_PANES + 1; i++) t = split(t, `p${i - 1}`, "row", `p${i}`, `s${i}`);
    expect(restore(t)).toBeNull();
    let deep: any = { kind: "pane", id: "leaf" };
    for (let i = 0; i < 20; i++) deep = { kind: "split", id: `d${i}`, dir: "row", ratio: 0.5, a: deep, b: { kind: "pane", id: `x${i}` } };
    expect(restore(deep)).toBeNull();
  });
});
