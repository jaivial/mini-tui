/** Rearranging panes in a window: moving one left/right/up/down, swapping two, and the presets. */
import { describe, expect, test } from "bun:test";
import { leaves, restore, setRatio, split, type Node } from "../web/src/lib/panes";
import { canMove, move, neighbourOf, preset, rects, swap, type MoveDir } from "../web/src/lib/paneLayout";

const one: Node = { kind: "pane", id: "p1" };

/** p1 | (p2 / p3), all even: p1 is half the width, p2 and p3 a quarter each. */
const tree: Node = split(split(one, "p1", "row", "p2", "s1"), "p2", "col", "p3", "s2");

describe("rects", () => {
  test("every pane gets the area its branch of the tree says", () => {
    const r = rects(tree, 800, 400);
    expect(r.get("p1")).toEqual({ x: 0, y: 0, w: 400, h: 400 });
    expect(r.get("p2")).toEqual({ x: 400, y: 0, w: 400, h: 200 });
    expect(r.get("p3")).toEqual({ x: 400, y: 200, w: 400, h: 200 });
  });
  test("a split's ratios move the edge, not just the leaf", () => {
    const r = rects(setRatio(tree, "s1", 0.25), 800, 400);
    expect(r.get("p1")).toEqual({ x: 0, y: 0, w: 200, h: 400 });
    expect(r.get("p2")).toEqual({ x: 200, y: 0, w: 600, h: 200 });
  });
});

describe("neighbourOf", () => {
  test("right and left follow the tree's reading order when panes are side by side", () => {
    expect(neighbourOf(tree, "p1", "right", 800, 400)).toBe("p2");
    expect(neighbourOf(tree, "p2", "left", 800, 400)).toBe("p1");
  });
  test("down and up go to the pane in the same column, not the next in reading order", () => {
    expect(neighbourOf(tree, "p2", "down", 800, 400)).toBe("p3");
    expect(neighbourOf(tree, "p3", "up", 800, 400)).toBe("p2");
    // p3 sits below-right of p1: up from p3 is p2 (above it), never p1.
    expect(neighbourOf(tree, "p3", "up", 800, 400)).not.toBe("p1");
  });
  test("a pane at the window's edge has no neighbour in that direction", () => {
    expect(neighbourOf(tree, "p1", "left", 800, 400)).toBeNull();
    expect(neighbourOf(tree, "p1", "up", 800, 400)).toBeNull();
    expect(neighbourOf(tree, "p2", "right", 800, 400)).toBeNull();
    expect(neighbourOf(tree, "p3", "down", 800, 400)).toBeNull();
  });
  test("the nearest edge wins when two panes are stacked in the same direction", () => {
    // p1 | p2 | p3 in a row: from p1, right is p2, not p3.
    const row = preset(["p1", "p2", "p3"], "row");
    expect(neighbourOf(row, "p1", "right", 900, 100)).toBe("p2");
    expect(neighbourOf(row, "p3", "right", 900, 100)).toBeNull();
  });
  test("a shorter pane reaches the one above it, and skips nothing sideways", () => {
    // (p1 / p3) | p2: p3 is a quarter of the window, p1 half of it.
    let t: Node = split(one, "p1", "row", "p2", "s1");
    t = split(t, "p1", "col", "p3", "s2");
    expect(leaves(t)).toEqual(["p1", "p3", "p2"]);
    expect(neighbourOf(t, "p3", "up", 800, 400)).toBe("p1");
    expect(neighbourOf(t, "p3", "right", 800, 400)).toBe("p2");
    expect(neighbourOf(t, "p2", "left", 800, 400)).toBe("p1");
  });
  test("a pane the tree does not hold has no neighbour", () => {
    expect(neighbourOf(tree, "zz", "left", 800, 400)).toBeNull();
  });
});

describe("swap and move", () => {
  test("swapping trades the ids and keeps the shape (and so the ratios) as it was", () => {
    const t = swap(tree, "p1", "p3");
    expect(leaves(t)).toEqual(["p3", "p2", "p1"]);
    expect(JSON.parse(JSON.stringify(t))).toEqual({ kind: "split", id: "s1", dir: "row", ratio: 0.5, a: { kind: "pane", id: "p3" }, b: { kind: "split", id: "s2", dir: "col", ratio: 0.5, a: { kind: "pane", id: "p2" }, b: { kind: "pane", id: "p1" } } });
  });
  test("a swap never leaves one id in two places, whatever the shape", () => {
    for (const a of ["p1", "p2", "p3"]) for (const b of ["p1", "p2", "p3"]) {
      const t = swap(tree, a, b);
      expect(leaves(t).sort()).toEqual(["p1", "p2", "p3"]);
      expect(restore(JSON.parse(JSON.stringify(t)))).toEqual(t); // no duplicate ids
    }
  });
  test("swapping a pane with itself, or an unknown one, changes nothing", () => {
    expect(swap(tree, "p1", "p1")).toBe(tree);
    expect(swap(tree, "zz", "p1")).toBe(tree);
  });
  test("move left trades places with the pane on the left", () => {
    expect(leaves(move(tree, "p2", "left", 800, 400))).toEqual(["p2", "p1", "p3"]);
  });
  test("move into an empty direction is the same tree back", () => {
    expect(move(tree, "p1", "left", 800, 400)).toBe(tree);
    expect(move(tree, "zz", "left", 800, 400)).toBe(tree);
  });
  test("all four directions are covered, and the round trip comes back to where it started", () => {
    let t = tree;
    t = move(t, "p1", "right", 800, 400);
    expect(leaves(t)).toEqual(["p2", "p1", "p3"]);
    t = move(t, "p1", "left", 800, 400);
    expect(leaves(t)).toEqual(["p1", "p2", "p3"]);
    t = move(t, "p2", "down", 800, 400);
    expect(leaves(t)).toEqual(["p1", "p3", "p2"]);
    t = move(t, "p2", "up", 800, 400);
    expect(leaves(t)).toEqual(["p1", "p2", "p3"]);
  });
  test("a move survives a save and a reload: restore() still accepts the tree", () => {
    const t = move(tree, "p3", "up", 800, 400);
    expect(restore(JSON.parse(JSON.stringify(t)))).toEqual(t);
  });
  test("canMove says which directions exist, for the menu's disabled rows", () => {
    expect(canMove(tree, "p1", "right", 800, 400)).toBe(true);
    expect(canMove(tree, "p1", "left", 800, 400)).toBe(false);
    expect(canMove(tree, "p1", "down", 800, 400)).toBe(false);
    expect(canMove(tree, "p3", "down", 800, 400)).toBe(false);
  });
});

describe("preset", () => {
  test("one row, left to right", () => {
    const t = preset(["p1", "p2", "p3"], "row");
    expect(leaves(t)).toEqual(["p1", "p2", "p3"]);
    const r = rects(t, 900, 100);
    expect(r.get("p1")).toEqual({ x: 0, y: 0, w: 300, h: 100 });
    expect(r.get("p3")).toEqual({ x: 600, y: 0, w: 300, h: 100 });
  });
  test("one column, top to bottom", () => {
    const t = preset(["p1", "p2", "p3"], "col");
    expect(leaves(t)).toEqual(["p1", "p2", "p3"]);
    const r = rects(t, 100, 900);
    expect(r.get("p2")).toEqual({ x: 0, y: 300, w: 100, h: 300 });
  });
  test("grid: rows of three, then the remainder, read left to right and top to bottom", () => {
    const ids = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
    const t = preset(ids, "grid");
    expect(leaves(t)).toEqual(ids);
    const r = rects(t, 900, 900);
    expect(r.get("p1")).toEqual({ x: 0, y: 0, w: 300, h: 300 });
    expect(r.get("p4")).toEqual({ x: 0, y: 300, w: 300, h: 300 });
    expect(r.get("p7")).toEqual({ x: 0, y: 600, w: 900, h: 300 }); // the last row has one pane: it takes the width
  });
  test("a grid of one row is that row, not a column of it", () => {
    const t = preset(["p1", "p2"], "grid");
    expect(rects(t, 200, 100).get("p2")).toEqual({ x: 100, y: 0, w: 100, h: 100 });
  });
  test("every preset leaves one pane when there is one pane", () => {
    expect(preset(["p1"], "grid")).toEqual(one);
    expect(preset(["p1"], "row")).toEqual(one);
  });
  test("a preset of the panes there are now keeps them all and stays under the pane limit", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `p${i + 1}`);
    for (const shape of ["row", "col", "grid"] as const) {
      const t = preset(ids, shape);
      expect(leaves(t)).toEqual(ids);
      expect(restore(JSON.parse(JSON.stringify(t)))).toEqual(t);
    }
  });
  test("nothing is refused: any arrangement save/restore round-trips", () => {
    let t: Node = preset(["p1", "p2", "p3", "p4"], "grid");
    for (const dir of ["right", "down", "left", "up"] as MoveDir[]) {
      const next = move(t, "p1", dir, 800, 600);
      if (next !== t) expect(restore(JSON.parse(JSON.stringify(next)))).toEqual(next);
    }
  });
});
