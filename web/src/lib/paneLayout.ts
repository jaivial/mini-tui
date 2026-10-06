/**
 * Rearranging panes inside a window, apart from any UI: the tree in `lib/panes.ts` says where panes
 * sit; this module changes it. Three questions live here:
 *
 * - **Move** a pane left / right / up / down: which pane is next to it in that direction, so the two
 *   can trade places. Answered with geometry (`rects`), not with tree walking, because "the pane to
 *   the left" is not the previous one in reading order once panes are stacked.
 * - **Swap** two panes by drag and drop: the same trade, named directly.
 * - **Preset** layouts (one row, one column, grid): a fresh, even tree for the panes there are, in
 *   the reading order they already have.
 *
 * Pure functions only, so every rule is testable without a browser. Nothing here creates or removes
 * panes and nothing touches a pane's contents: only the shape of the tree changes.
 */
import { leaves, type Dir, type Node } from "./panes";

export type MoveDir = "left" | "right" | "up" | "down";

/**
 * What a drag of a pane carries, so a drop meant for the pane layout is never mistaken for a drop of
 * a file, a link or a piece of text (dropping either on a pane must do what it always did: nothing).
 */
export const PANE_MIME = "application/x-mini-tui-pane";
export type Shape = "row" | "col" | "grid";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where every pane sits in a `w` x `h` layout, in the reading order they are visited. */
export function rects(node: Node, w: number, h: number, x = 0, y = 0, out = new Map<string, Rect>()): Map<string, Rect> {
  if (node.kind === "pane") {
    out.set(node.id, { x, y, w, h });
    return out;
  }
  if (node.dir === "row") {
    const aw = Math.round(w * node.ratio);
    rects(node.a, aw, h, x, y, out);
    rects(node.b, w - aw, h, x + aw, y, out);
  } else {
    const ah = Math.round(h * node.ratio);
    rects(node.a, w, ah, x, y, out);
    rects(node.b, w, h - ah, x, y + ah, out);
  }
  return out;
}

/**
 * How far `to` is beyond the edge `dir` points at from `from`: 0 when the two edges touch (as two panes
 * side by side do), more when something else is in between, negative when `to` is not that way at all.
 */
function beyond(from: Rect, to: Rect, dir: MoveDir): number {
  switch (dir) {
    case "left":
      return from.x - (to.x + to.w);
    case "right":
      return to.x - (from.x + from.w);
    case "up":
      return from.y - (to.y + to.h);
    case "down":
      return to.y - (from.y + from.h);
  }
}

/** How much of `from`'s side `to` covers, in the axis across `dir`: 0 means not facing it at all. */
function facing(from: Rect, to: Rect, dir: MoveDir): number {
  if (dir === "left" || dir === "right") {
    const lo = Math.max(from.y, to.y);
    return Math.min(from.y + from.h, to.y + to.h) - lo;
  }
  const lo = Math.max(from.x, to.x);
  return Math.min(from.x + from.w, to.x + to.w) - lo;
}

/** A pixel of slack: rects are rounded to whole pixels, so two touching edges may differ by one. */
const SLACK = 1.5;

/**
 * The pane `dir` points at from `paneId`: the nearest one that is that way and also faces it, so the
 * pane above a short pane is whichever one really is above it, not merely the first in the column.
 * Null when nothing is there (the pane is already at that edge of the window).
 */
export function neighbourOf(node: Node, paneId: string, dir: MoveDir, w: number, h: number): string | null {
  const all = rects(node, w, h);
  const me = all.get(paneId);
  if (!me) return null;
  let best: string | null = null;
  let bestGap = Infinity;
  for (const [id, r] of all) {
    if (id === paneId) continue;
    const d = beyond(me, r, dir);
    if (d < -SLACK || facing(me, r, dir) <= 0) continue; // not that way, or not facing it
    if (d < bestGap) {
      bestGap = d;
      best = id;
    }
  }
  return best;
}

/**
 * Trade the places of two panes, contents and all: every leaf named `a` becomes `b` and every `b`
 * becomes `a`, in one pass, so neither id is left in two places. Both panes must be in the tree;
 * anything else comes back untouched.
 */
export function swap(node: Node, a: string, b: string): Node {
  if (a === b || !has(node, a) || !has(node, b)) return node;
  const walk = (n: Node): Node => {
    if (n.kind === "pane") return n.id === a ? { kind: "pane", id: b } : n.id === b ? { kind: "pane", id: a } : n;
    const na = walk(n.a);
    const nb = walk(n.b);
    return na === n.a && nb === n.b ? n : { ...n, a: na, b: nb };
  };
  return walk(node);
}

/** Whether the tree holds a pane at all (a move to a pane that is not there must do nothing). */
export function has(node: Node, paneId: string): boolean {
  return node.kind === "pane" ? node.id === paneId : has(node.a, paneId) || has(node.b, paneId);
}

/**
 * Move a pane one place in `dir`, trading places with the neighbour there. The tree comes back
 * unchanged when the pane is not there or nothing lies in that direction, so the caller can tell
 * "done" from "impossible" by comparing.
 */
export function move(node: Node, paneId: string, dir: MoveDir, w: number, h: number): Node {
  const other = neighbourOf(node, paneId, dir, w, h);
  return other ? swap(node, paneId, other) : node;
}

/** Whether a pane has anything at all in `dir` (the menu greys the action out when it has not). */
export function canMove(node: Node, paneId: string, dir: MoveDir, w: number, h: number): boolean {
  return neighbourOf(node, paneId, dir, w, h) !== null;
}

/** Half the nodes go left (or up) at each split: `ratio = left / total` keeps every branch even. */
function build(nodes: Node[], dir: Dir): Node {
  if (nodes.length === 1) return nodes[0]!;
  const left = Math.floor(nodes.length / 2);
  return {
    kind: "split",
    // The split ids only have to be unique inside the tree; the leaf that starts the right half names them.
    id: `l${leaves(nodes[left]!)[0]!.slice(1)}-${nodes.length}`,
    dir,
    ratio: left / nodes.length,
    a: build(nodes.slice(0, left), dir),
    b: build(nodes.slice(left), dir),
  };
}

/** The even layout `shape` makes of these panes, in the reading order given. */
export function preset(ids: string[], shape: Shape): Node {
  if (!ids.length) throw new Error("a layout needs at least one pane");
  if (ids.length === 1) return { kind: "pane", id: ids[0]! };
  if (shape !== "grid") return build(ids.map((id) => ({ kind: "pane", id }) as Node), shape);
  // Rows of three (a 4:3 window), then the remainder; the rows stack.
  const cols = Math.ceil(Math.sqrt(ids.length));
  const rows: Node[][] = [];
  for (let i = 0; i < ids.length; i += cols) rows.push(ids.slice(i, i + cols).map((id) => ({ kind: "pane", id }) as Node));
  if (rows.length === 1) return build(rows[0]!, "row");
  return build(rows.map((row) => build(row, "row")), "col");
}
