/**
 * Windows: named groups of panes. The screen shows one window at a time; every window lays its panes
 * out the way `lib/panes.ts` does for one. The sidebar lists them (with a pane count each) and has a
 * button to start a new one, and any pane can move to another window or to a new one.
 *
 * Only the order, the names and which window is on screen live here. The panes themselves, their tree
 * and what each one shows belong to `panes.svelte.ts`, which keeps one set per window and swaps them on
 * a switch (so a half-typed prompt survives moving a pane out and back). Everything is saved to
 * the shared workspace with the panes (`lib/workspace.ts`), so every device shows the same windows.
 */
import { shallowEqual } from "../equal";
import { savePart, startingDoc } from "../workspace";
import { legacy } from "../legacy";
export { legacy };

export interface Win {
  id: string;
  /** What you called it, or null for "Window 3". */
  name: string | null;
}

/** The shape this store writes into the shared workspace (and compares against before writing). */
interface WindowSnapshot {
  v: 1;
  list: Win[];
  active: string;
}

const KEY = "minitui.windows";

export const uid = (p: string) => `${p}${Math.random().toString(36).slice(2, 9)}`;

class WindowStore {
  list = $state<Win[]>([]);
  /** The window on screen. */
  activeId = $state("");
  /**
   * The id of a window this store created but the app has not taken yet. A new window must open empty
   * (a new chat, not the panes that were on screen), and "open the session in a new window" must open
   * it there: both read this once and clear it.
   */
  createdId = $state("");

  /** Names and order read back from the workspace. Empty on a first visit or an unreadable value. */
  #load(): boolean {
    return this.#read(startingDoc().windows ?? legacy(KEY));
  }
  #read(value: unknown): boolean {
    try {
      const raw = value as { v?: number; list?: unknown; active?: unknown } | null;
      if (!raw || raw.v !== 1 || !Array.isArray(raw.list)) return false;
      const list: Win[] = [];
      for (const w of raw.list) {
        if (!w || typeof w !== "object") return false;
        const id = typeof (w as Win).id === "string" && /^[\w-]{1,64}$/.test((w as Win).id) ? (w as Win).id : null;
        if (!id || list.some((x) => x.id === id)) return false;
        list.push({ id, name: typeof (w as Win).name === "string" && (w as Win).name!.trim() ? (w as Win).name : null });
      }
      if (!list.length) return false;
      const active = typeof raw.active === "string" && list.some((w) => w.id === raw.active) ? raw.active : list[0]!.id;
      this.list = list;
      this.activeId = active;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Bring back what was saved. Without it (a first visit, or storage said nothing) there is one window,
   * called nothing: the app's own first-run panes go into it.
   */
  adopt(): boolean {
    if (this.#load()) return true;
    this.list = [{ id: uid("w"), name: null }];
    this.activeId = this.list[0]!.id;
    return false;
  }

  /** A brand new window, on screen. The caller opens it empty; see `createdId`. */
  create(name: string | null = null): string {
    const win: Win = { id: uid("w"), name: name?.trim() ? name.trim() : null };
    this.list = [...this.list, win];
    this.activeId = win.id;
    this.createdId = win.id;
    this.save();
    return win.id;
  }

  rename(id: string, name: string) {
    const win = this.list.find((w) => w.id === id);
    if (!win) return;
    const clean = name.trim();
    win.name = clean ? clean : null;
    this.save();
  }

  /** Close a window: its panes go first (the app closes the sessions it alone was showing). */
  remove(id: string): boolean {
    if (this.list.length < 2 || !this.list.some((w) => w.id === id)) return false;
    const i = this.list.findIndex((w) => w.id === id);
    const list = this.list.filter((w) => w.id !== id);
    this.list = list;
    if (this.activeId === id) this.activeId = list[Math.max(0, i - 1)]!.id;
    this.save();
    return true;
  }

  /** Another window on screen. The caller swaps the panes over. */
  activate(id: string): boolean {
    if (!this.list.some((w) => w.id === id) || this.activeId === id) return false;
    this.activeId = id;
    this.save();
    return true;
  }

  /** Take the new window this store opened: it is no longer "new" for the next caller. */
  takeCreated(): string | null {
    const id = this.createdId;
    this.createdId = "";
    return id || null;
  }

  /** "Window 2", or the name you gave it: the label in the sidebar and in the pane menus. */
  label(id: string, total: (id: string) => number): string {
    const win = this.list.find((w) => w.id === id);
    if (!win) return "Window";
    void total;
    return win.name?.trim() ? win.name : `Window ${this.list.indexOf(win) + 1}`;
  }

  /** A name that is not taken yet, for pre-filling a rename. */
  suggestion(id: string): string {
    const n = this.list.findIndex((w) => w.id === id) + 1;
    let name = `Window ${n}`;
    for (let i = 2; this.list.some((w) => w.name === name); i++) name = `Window ${n} (${i})`;
    return name;
  }

  /** The value saved to the shared workspace (the pane store saves it together with the panes). */
  snapshot(): WindowSnapshot {
    return { v: 1, list: $state.snapshot(this.list), active: this.activeId };
  }
  save() {
    const next = this.snapshot();
    // A window switch writes the panes and the windows as one version; the pane store has usually
    // already sent this exact list, so do not make the client stringify it again to find that out.
    if (this.#saved !== undefined && shallowEqual(next, this.#saved)) return;
    this.#saved = next;
    savePart("windows", next);
  }
  /** The last value written, so a save that says the same thing stops here. */
  #saved?: WindowSnapshot;

  /** Another device changed the windows: take its list, names and which one is on screen. */
  adoptRemote(raw: unknown): boolean {
    const before = JSON.stringify(this.snapshot());
    const prev = { list: this.list, active: this.activeId };
    if (!this.#read(raw)) {
      this.list = prev.list;
      this.activeId = prev.active;
      return false;
    }
    const changed = JSON.stringify(this.snapshot()) !== before;
    if (changed) this.#saved = undefined; // the next save must go out, whatever it was
    return changed;
  }
}

export const windows = new WindowStore();
