/**
 * The panes, tmux style: a layout tree (`lib/panes.ts`) and, per pane, what it shows and what is being
 * typed in it. One pane has focus; the sidebar, `/resume` and the keyboard act on it.
 *
 * Everything a pane holds lives here, not in its component: splitting moves a pane to a new place in
 * the tree, which remounts its component, and a half-typed prompt must survive that. The layout and
 * which session each pane shows are saved to localStorage, so a reload brings the same panes back;
 * prompts and chips are not (the same as before panes existed).
 *
 * There is one tree, one set of panes and one focus **per window** (`windows.svelte.ts`): switching
 * window swaps all three over, so what you were typing in one is still there when you come back. Only
 * the window on screen is in `tree` / `panes` / `focusedId` at a time; every pane id in the app is
 * unique across windows, so the components need not know about windows at all.
 */
import { MAX_PANES, count, leaves, neighbour, remove, restore, setRatio, split, type Dir, type Node } from "../panes";
import type { Chip } from "../chips";
import { PromptMemory } from "../promptMemory";
import { windows } from "./windows.svelte";

export interface Pane {
  id: string;
  /** The session shown, or null for a new chat (created by its first message). */
  sessionId: string | null;
  /** A new chat's choices, used by its first message. */
  draft: { targetId: string; model: string; cwd: string };
  prompt: string;
  chips: Chip[];
  notesOpen: boolean;
  /** Which tab the right sidebar shows while it is open. */
  sideTab: "notes" | "terminal";
  /** ↑/↓ prompt recall. Not reactive state: it is read on a key press, never rendered. */
  memory: PromptMemory;
  /** The session the memory was seeded from, so it is reseeded when the pane shows another one. */
  memoryOf: string | null;
}

const KEY = "minitui.panes";
const uid = (p: string) => `${p}${Math.random().toString(36).slice(2, 9)}`;
const blank = (id = uid("p")): Pane => ({ id, sessionId: null, draft: { targetId: "local", model: "", cwd: "" }, prompt: "", chips: [], notesOpen: false, sideTab: "notes", memory: new PromptMemory(), memoryOf: null });

/** The first pane of a first visit. Any id works; it only has to be unique like every other one. */
const FIRST = uid("p");

/** The same tree with some pane ids replaced (splits keep theirs). */
function renameLeaves(node: Node, to: Map<string, string>): Node {
  if (node.kind === "pane") return to.has(node.id) ? { kind: "pane", id: to.get(node.id)! } : node;
  return { ...node, a: renameLeaves(node.a, to), b: renameLeaves(node.b, to) };
}

/** What is written to localStorage for one window: the tree, what each pane shows, where the focus was. */
interface Saved {
  tree: Node;
  panes: Record<string, { sessionId: string | null; notesOpen: boolean; sideTab: "notes" | "terminal" }>;
  focused: string;
}

class PaneStore {
  /** The window on screen: its layout, its panes and where the focus is. Swapped on a window switch. */
  tree = $state<Node>({ kind: "pane", id: FIRST });
  panes = $state<Record<string, Pane>>({ [FIRST]: blank(FIRST) });
  focusedId = $state(FIRST);
  /** A saved layout was brought back. When not (a first visit), the app opens the latest session. */
  restored = false;

  /** Everything a window holds, kept while another window is on screen. */
  #kept: Record<string, { tree: Node; panes: Record<string, Pane>; focused: string }> = {};
  /** The window `tree`, `panes` and `focusedId` are showing right now. */
  #wid = "";

  constructor() {
    windows.adopt();
    this.#wid = windows.activeId;
    this.#load();
  }

  get order(): string[] {
    return leaves(this.tree);
  }
  get count(): number {
    return count(this.tree);
  }
  get focused(): Pane {
    return this.panes[this.focusedId] ?? this.panes[this.order[0]!]!;
  }
  get canSplit(): boolean {
    return this.count < MAX_PANES;
  }
  /** Every session shown in some pane, in this window or shelved in another (their sockets stay open). */
  get shown(): string[] {
    const out: string[] = [];
    for (const set of [this.#hold(), ...Object.values(this.#kept)]) {
      for (const p of Object.values(set.panes)) if (p.sessionId) out.push(p.sessionId);
    }
    return [...new Set(out)];
  }
  /** The pane showing a session, on screen or in another window. */
  paneOf(sessionId: string): Pane | null {
    return [...Object.values(this.panes), ...Object.values(this.#kept).flatMap((k) => Object.values(k.panes))].find((p) => p.sessionId === sessionId) ?? null;
  }
  /** Forget a window's shelved panes (it was closed; it had none to keep). */
  dropWindow(id: string) {
    delete this.#kept[id];
    if (this.#wid !== id) this.#save();
  }

  /** How many panes a window holds, on screen or shelved. */
  paneCount(id: string): number {
    return id === this.#wid ? this.count : (this.#kept[id] ? count(this.#kept[id]!.tree) : 0);
  }

  /** Which window has the pane showing `sessionId` ("w3"), for the sidebar's label. */
  windowOf(sessionId: string): string | null {
    const pane = this.paneOf(sessionId);
    if (!pane) return null;
    for (const [id, set] of Object.entries(this.#kept)) if (pane.id in set.panes) return id;
    return this.#wid;
  }
  /** The pane showing `sessionId`, if any. */
  /** 1-based position in reading order (what the pane's label and the tabs show). */
  numberOf(paneId: string): number {
    return this.order.indexOf(paneId) + 1;
  }

  // ------------------------------------------------------------ windows

  /**
   * The panes of the window on screen, to shelve. The pane objects themselves are kept, never a
   * `$state.snapshot` of them: a snapshot is a deep plain clone, and it turns each pane's
   * `PromptMemory` (a class) into a bare object without its methods. Back on screen, the prompt
   * bar's `memory.push()` then threw before the message was sent, so Send silently did nothing
   * until a reload. Only the tree, which is plain data, is snapshotted.
   */
  #hold(): { tree: Node; panes: Record<string, Pane>; focused: string } {
    return { tree: $state.snapshot(this.tree) as Node, panes: { ...this.panes }, focused: this.focusedId };
  }
  /** Put a shelved window back on screen. */
  #unhold(w: { tree: Node; panes: Record<string, Pane>; focused: string }) {
    this.tree = w.tree;
    this.panes = w.panes;
    this.focusedId = w.panes[w.focused] ? w.focused : leaves(w.tree)[0]!;
  }

  /** Show another window: these panes go on the shelf, that window's come back. */
  switchTo(id: string) {
    windows.activate(id);
    this.#swapTo(id);
  }
  #swapTo(id: string) {
    windows.activate(id); // the window on screen is whatever these panes belong to
    if (id === this.#wid) return;
    this.#kept[this.#wid] = this.#hold();
    this.#wid = id;
    const kept = this.#kept[id];
    if (kept) {
      delete this.#kept[id];
      this.#unhold(kept);
    } else {
      // A window nobody has filled yet: one empty pane, the way the app starts. Its id must be new:
      // pane ids are unique across every window (the lookups below search them all).
      const first = blank();
      this.tree = { kind: "pane", id: first.id };
      this.panes = { [first.id]: first };
      this.focusedId = first.id;
    }
    this.#save();
  }

    /** A window that has just been asked for opens empty: one new chat, nothing from this one. */
  openBlank() {
    if (windows.activeId !== this.#wid) {
      if (this.count) this.#kept[this.#wid] = this.#hold(); // shelve what is on screen
      delete this.#kept[windows.activeId];
      this.#wid = windows.activeId;
    }
    const first = blank();
    this.tree = { kind: "pane", id: first.id };
    this.panes = { [first.id]: first };
    this.focusedId = first.id;
    this.#save();
  }

  /** Put `pane` in a shelved window, beside its first pane, and focus it there. */
  #plant(shelf: { tree: Node; panes: Record<string, Pane>; focused: string }, pane: Pane) {
    const first = shelf.tree.kind === "pane" ? shelf.tree.id : leaves(shelf.tree)[0]!;
    if (!shelf.panes[first]) {
      // An untouched window (one empty pane): the move becomes its whole content.
      shelf.tree = { kind: "pane", id: pane.id };
      shelf.panes = { [pane.id]: pane };
      shelf.focused = pane.id;
      return;
    }
    shelf.panes[pane.id] = { ...pane, prompt: "", chips: [] };
    shelf.tree = split(shelf.tree, first, "row", pane.id, `s${pane.id.slice(1)}`);
    shelf.focused = pane.id;
  }

  /**
   * Move a pane to window `to` (or to a new one). It keeps its session, its tab and its notes; the
   * window it leaves folds if that was its last pane, and the app follows the pane to where it went.
   * Returns the id of the window that has it now, or null when the move cannot happen.
   */
  sendTo(paneId: string, to: string | "new", name?: string): string | null {
    const pane = this.panes[paneId];
    if (!pane) return null;
    const target = to === "new" ? windows.create(name) : to;
    if (!windows.list.some((w) => w.id === target) || (to !== "new" && target === this.#wid)) return null;
    const here = this.#wid;
    // Whatever is on screen, the other window's panes live on the shelf: plant it there.
    const shelf = (this.#kept[target] ??= { tree: { kind: "pane", id: blank().id }, panes: {}, focused: "" });
    if (count(shelf.tree) >= MAX_PANES) {
      if (to === "new") windows.remove(target); // a window made for nothing is not kept
      return null;
    }
    if (this.count === 1) {
      // The last pane here: the window it leaves folds into the move, as tmux breaks a last pane out.
      if (here !== target) windows.remove(here);
      this.#plant(shelf, pane);
      windows.activate(target);
      this.#wid = target;
      delete this.#kept[target];
      this.#unhold(shelf);
      this.#save();
      return target;
    }
    const next = neighbour(this.tree, paneId);
    this.tree = remove(this.tree, paneId);
    const { [paneId]: _gone, ...rest } = this.panes;
    this.panes = rest;
    if (this.focusedId === paneId && next) this.focusedId = next;
    this.#plant(shelf, pane);
    this.#swapTo(target); // the pane went there, so the app follows it; this also un-shelves the target
    this.#save();
    return target;
  }

  focus(paneId: string) {
    if (!this.panes[paneId] || this.focusedId === paneId) return;
    this.focusedId = paneId;
    this.#save();
  }

  /** Previous / next pane in reading order, wrapping. */
  cycle(dir: 1 | -1) {
    const ids = this.order;
    const i = ids.indexOf(this.focusedId);
    this.focus(ids[(i + dir + ids.length) % ids.length]!);
  }

  /** Split a pane; the new pane is a new chat and takes focus. Returns its id, or null at the limit. */
  split(paneId: string, dir: Dir): string | null {
    if (!this.canSplit || !this.panes[paneId]) return null;
    const fresh = blank();
    this.panes[fresh.id] = fresh;
    this.tree = split(this.tree, paneId, dir, fresh.id, uid("s"));
    this.focusedId = fresh.id;
    this.#save();
    return fresh.id;
  }

  /** Close a pane (its session keeps running and stays in the sidebar). The last pane cannot close. */
  close(paneId: string): boolean {
    if (this.count < 2 || !this.panes[paneId]) return false;
    const next = neighbour(this.tree, paneId);
    this.tree = remove(this.tree, paneId);
    delete this.panes[paneId];
    if (this.focusedId === paneId && next) this.focusedId = next;
    this.#save();
    return true;
  }

  resize(splitId: string, ratio: number) {
    this.tree = setRatio(this.tree, splitId, ratio);
    this.#saveSoon();
  }

  /**
   * Show a session in a pane. A session is shown in one pane at most: if another pane already shows
   * it, that pane is focused instead (two prompt bars for one conversation would race each other).
   */
  show(paneId: string, sessionId: string | null): string {
    if (sessionId) {
      const other = this.paneOf(sessionId);
      if (other && other.id !== paneId) {
        // Already shown somewhere: go to that pane (switching window first when it is on another one)
        // and leave the pane you were in exactly as it was. The window's own last focus does not
        // matter here: the pane showing this session is the one that takes focus.
        const wid = this.windowOf(sessionId);
        if (wid && wid !== this.#wid) this.switchTo(wid);
        this.focus(other.id);
        return other.id;
      }
    }
    const pane = this.panes[paneId];
    if (!pane) return paneId;
    if (pane.sessionId !== sessionId) {
      pane.sessionId = sessionId;
      pane.prompt = "";
      pane.chips = [];
      if (!sessionId) pane.draft = { targetId: "local", model: "", cwd: "" };
    }
    this.focus(paneId);
    this.#save();
    return paneId;
  }

  /** Sessions that no longer exist (deleted, closed elsewhere): their panes become new chats. */
  forgetMissing(exists: (sessionId: string) => boolean) {
    let changed = false;
    for (const pane of Object.values(this.panes)) {
      if (pane.sessionId && !exists(pane.sessionId)) {
        pane.sessionId = null;
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  toggleNotes(paneId: string, open?: boolean) {
    this.toggleSide(paneId, "notes", open);
  }

  /**
   * The right sidebar, opened on `tab`. Pressing the button of the tab already showing closes it; the
   * other tab's button switches to that tab instead of closing (one button per tab, one panel).
   */
  toggleSide(paneId: string, tab: "notes" | "terminal", open?: boolean) {
    const pane = this.panes[paneId];
    if (!pane) return;
    if (open === undefined) open = !(pane.notesOpen && pane.sideTab === tab);
    pane.notesOpen = open;
    if (open) pane.sideTab = tab;
    this.#save();
  }

  // ------------------------------------------------------------ persistence

  #timer: ReturnType<typeof setTimeout> | undefined;
  #saveSoon() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#save(), 250);
  }
  #one(tree: Node, panes: Record<string, Pane>, focused: string): Saved {
    return { tree: $state.snapshot(tree) as Node, panes: Object.fromEntries(Object.entries(panes).map(([id, p]) => [id, { sessionId: p.sessionId, notesOpen: p.notesOpen, sideTab: p.sideTab }])), focused };
  }
  #save() {
    try {
      const byWindow: Record<string, Saved> = {};
      for (const [id, set] of Object.entries(this.#kept)) byWindow[id] = this.#one(set.tree, set.panes, set.focused);
      byWindow[this.#wid] = this.#one(this.tree, this.panes, this.focusedId);
      localStorage.setItem(KEY, JSON.stringify({ v: 2, byWindow, focused: this.focusedId }));
      windows.save(); // the ids above mean nothing if the list of windows is not saved with them
    } catch {
      /* private mode, or storage full: panes still work, they just are not remembered */
    }
  }
  #load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as
        | { v?: number; byWindow?: Record<string, { tree?: unknown; panes?: Record<string, { sessionId?: unknown; notesOpen?: unknown; sideTab?: unknown }>; focused?: unknown }>; tree?: unknown; panes?: unknown; focused?: unknown }
        | null;
      if (!raw || (!raw.byWindow && raw.v !== 1)) return;
      if (raw.v === 1) raw.byWindow = { [windows.activeId]: { tree: raw.tree, panes: raw.panes as never, focused: raw.focused } }; // the old, one-window format
      if (raw.v !== 1 && raw.v !== 2) return;
      let cameBack = false;
      const taken = new Set<string>();
      for (const [wid, one] of Object.entries(raw.byWindow ?? {})) {
        if (!windows.list.some((w) => w.id === wid)) continue; // a window that is gone takes its panes with it
        const tree = restore(one?.tree);
        if (!tree) continue;
        // Pane ids must be unique across windows. Layouts saved before that held (every window's
        // first pane was "p1") get fresh ids for any id another window already took.
        const renamed = new Map<string, string>();
        for (const id of leaves(tree)) if (taken.has(id)) renamed.set(id, uid("p"));
        const fixedTree = renamed.size ? renameLeaves(tree, renamed) : tree;
        const panes: Record<string, Pane> = {};
        for (const id of leaves(tree)) {
          const saved = one?.panes?.[id];
          const nid = renamed.get(id) ?? id;
          taken.add(nid);
          panes[nid] = { ...blank(nid), sessionId: typeof saved?.sessionId === "string" ? saved.sessionId : null, notesOpen: saved?.notesOpen === true, sideTab: saved?.sideTab === "terminal" ? "terminal" : "notes" };
        }
        const savedFocus = typeof one?.focused === "string" ? (renamed.get(one.focused) ?? one.focused) : "";
        const focused = panes[savedFocus] ? savedFocus : leaves(fixedTree)[0]!;
        cameBack = true; // some saved layout came back: the app must not second-guess it on load
        if (wid === windows.activeId) {
          this.tree = fixedTree;
          this.panes = panes;
          this.focusedId = focused;
        } else this.#kept[wid] = { tree: fixedTree, panes, focused };
      }
      if (count(this.tree) !== 1 || this.#wid !== windows.activeId) this.#swapTo(windows.activeId);
      this.restored = cameBack;
    } catch {
      /* unreadable: start from one pane */
    }
  }
}

export const panes = new PaneStore();
