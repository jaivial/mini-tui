/**
 * The pane layout, tmux style: a binary tree whose leaves are panes and whose inner nodes split their
 * area in two, side by side ("row") or stacked ("col"), at a ratio the user can drag. Pure functions
 * only, so every rule is testable without a browser; the store holds the tree and the pane contents.
 */

export type Dir = "row" | "col";
export type Leaf = { kind: "pane"; id: string };
export type Split = { kind: "split"; id: string; dir: Dir; ratio: number; a: Node; b: Node };
export type Node = Leaf | Split;

/** More panes in one window than this stop being useful, and only cost sockets. */
export const MAX_PANES = 12;
/** A side of a split never gets less than this share, however far the divider is dragged. */
export const MIN_RATIO = 0.15;

export const clampRatio = (r: number) => (Number.isFinite(r) ? Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, r)) : 0.5);

/** Pane ids in reading order: left to right, top to bottom. This is the order of Alt+1..9 and of the tabs. */
export function leaves(node: Node): string[] {
  return node.kind === "pane" ? [node.id] : [...leaves(node.a), ...leaves(node.b)];
}

export function count(node: Node): number {
  return leaves(node).length;
}

/**
 * Split pane `target`: it keeps its place (left, or top) and the new pane `fresh` opens beside it,
 * right of it for "row" and below it for "col", the way tmux does. Unknown target: the tree is unchanged.
 */
export function split(node: Node, target: string, dir: Dir, fresh: string, splitId: string): Node {
  if (node.kind === "pane") {
    return node.id === target ? { kind: "split", id: splitId, dir, ratio: 0.5, a: node, b: { kind: "pane", id: fresh } } : node;
  }
  const a = split(node.a, target, dir, fresh, splitId);
  const b = a === node.a ? split(node.b, target, dir, fresh, splitId) : node.b;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** Remove a pane; its sibling takes the whole of their parent's area. The last pane cannot be removed. */
export function remove(node: Node, target: string): Node {
  if (node.kind === "pane") return node;
  if (node.a.kind === "pane" && node.a.id === target) return node.b;
  if (node.b.kind === "pane" && node.b.id === target) return node.a;
  const a = remove(node.a, target);
  const b = a === node.a ? remove(node.b, target) : node.b;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

export function setRatio(node: Node, splitId: string, ratio: number): Node {
  if (node.kind === "pane") return node;
  if (node.id === splitId) return { ...node, ratio: clampRatio(ratio) };
  const a = setRatio(node.a, splitId, ratio);
  const b = a === node.a ? setRatio(node.b, splitId, ratio) : node.b;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** The pane to focus after `closing` goes: the one before it in reading order, else the one after. */
export function neighbour(node: Node, closing: string): string | null {
  const ids = leaves(node);
  const i = ids.indexOf(closing);
  if (i === -1 || ids.length < 2) return null;
  return ids[i - 1] ?? ids[i + 1] ?? null;
}

/**
 * Could `target` be split in `dir` and leave both halves at least `min` wide (or tall)? `width` and
 * `height` are the whole layout's size. Walks down to the pane, halving the relevant side at each split
 * on the way, so a pane deep in the tree is judged by its real size, not the window's.
 */
export function roomToSplit(node: Node, target: string, dir: Dir, width: number, height: number, min: { w: number; h: number }): boolean {
  const size = sizeOf(node, target, width, height);
  if (!size) return false;
  return dir === "row" ? size.w / 2 >= min.w : size.h / 2 >= min.h;
}

export function sizeOf(node: Node, target: string, w: number, h: number): { w: number; h: number } | null {
  if (node.kind === "pane") return node.id === target ? { w, h } : null;
  const aw = node.dir === "row" ? w * node.ratio : w;
  const ah = node.dir === "col" ? h * node.ratio : h;
  return sizeOf(node.a, target, aw, ah) ?? sizeOf(node.b, target, node.dir === "row" ? w - aw : w, node.dir === "col" ? h - ah : h);
}

/**
 * A layout read back from storage is untrusted (an old version, a hand edit, a half-written value):
 * rebuild it, or return null so the caller starts from one pane. Duplicate ids, bad ratios, unknown
 * kinds, too-deep trees and too many panes are all refused rather than half-rendered.
 */
export function restore(raw: unknown): Node | null {
  const seen = new Set<string>();
  const id = (v: unknown) => (typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : null);
  const walk = (n: unknown, depth: number): Node | null => {
    // Deepest possible tree at the pane limit is a chain of MAX_PANES leaves: the depth a chain may
    // reach before it is refused as absurd, rather than trusted.
    if (!n || typeof n !== "object" || depth > MAX_PANES + 4) return null;
    const o = n as Record<string, unknown>;
    const nid = id(o.id);
    if (!nid || seen.has(nid)) return null;
    seen.add(nid);
    if (o.kind === "pane") return { kind: "pane", id: nid };
    if (o.kind !== "split" || (o.dir !== "row" && o.dir !== "col") || typeof o.ratio !== "number") return null;
    const a = walk(o.a, depth + 1);
    const b = a && walk(o.b, depth + 1);
    return a && b ? { kind: "split", id: nid, dir: o.dir, ratio: clampRatio(o.ratio), a, b } : null;
  };
  const tree = walk(raw, 0);
  return tree && count(tree) <= MAX_PANES ? tree : null;
}
