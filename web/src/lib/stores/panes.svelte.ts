/**
 * The panes, tmux style: a layout tree (`lib/panes.ts`) and, per pane, what it shows and what is being
 * typed in it. One pane has focus; the sidebar, `/resume` and the keyboard act on it.
 *
 * Everything a pane holds lives here, not in its component: splitting moves a pane to a new place in
 * the tree, which remounts its component, and a half-typed prompt must survive that. The layout and
 * which session each pane shows are saved to localStorage, so a reload brings the same panes back;
 * prompts and chips are not (the same as before panes existed).
 */
import { MAX_PANES, count, leaves, neighbour, remove, restore, setRatio, split, type Dir, type Node } from "../panes";
import type { Chip } from "../chips";
import { PromptMemory } from "../promptMemory";

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

class PaneStore {
  tree = $state<Node>({ kind: "pane", id: "p1" });
  panes = $state<Record<string, Pane>>({ p1: blank("p1") });
  focusedId = $state("p1");
  /** A saved layout was brought back. When not (a first visit), the app opens the latest session. */
  restored = false;

  constructor() {
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
  /** Every session shown in some pane (their sockets stay open). */
  get shown(): string[] {
    return this.order.map((id) => this.panes[id]?.sessionId).filter((s): s is string => !!s);
  }
  /** The pane showing `sessionId`, if any. */
  paneOf(sessionId: string): Pane | null {
    return Object.values(this.panes).find((p) => p.sessionId === sessionId) ?? null;
  }
  /** 1-based position in reading order (what the pane's label and the tabs show). */
  numberOf(paneId: string): number {
    return this.order.indexOf(paneId) + 1;
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
  #save() {
    try {
      const panes = Object.fromEntries(this.order.map((id) => [id, { sessionId: this.panes[id]?.sessionId ?? null, notesOpen: !!this.panes[id]?.notesOpen, sideTab: this.panes[id]?.sideTab ?? "notes" }]));
      localStorage.setItem(KEY, JSON.stringify({ v: 1, tree: $state.snapshot(this.tree), panes, focused: this.focusedId }));
    } catch {
      /* private mode, or storage full: panes still work, they just are not remembered */
    }
  }
  #load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as { v?: number; tree?: unknown; panes?: Record<string, { sessionId?: unknown; notesOpen?: unknown; sideTab?: unknown }>; focused?: unknown } | null;
      if (!raw || raw.v !== 1) return;
      const tree = restore(raw.tree);
      if (!tree) return;
      const panes: Record<string, Pane> = {};
      for (const id of leaves(tree)) {
        const saved = raw.panes?.[id];
        panes[id] = { ...blank(id), sessionId: typeof saved?.sessionId === "string" ? saved.sessionId : null, notesOpen: saved?.notesOpen === true, sideTab: saved?.sideTab === "terminal" ? "terminal" : "notes" };
      }
      this.tree = tree;
      this.panes = panes;
      this.focusedId = typeof raw.focused === "string" && panes[raw.focused] ? raw.focused : leaves(tree)[0]!;
      this.restored = true;
    } catch {
      /* unreadable: start from one pane */
    }
  }
}

export const panes = new PaneStore();
