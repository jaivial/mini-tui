/**
 * The notes editor's save queue, extracted from the panel: the rules that decide *what* a flush
 * sends and *which version* it names. Modelled here in plain TypeScript, with a fake note store and
 * a save that takes a turn to answer, because the bugs it guards against are all about what happens
 * between two saves — a timing the browser test can only hit by luck.
 *
 * This mirrors `flush()` in web/src/lib/components/NotesPanel.svelte.
 */
import { describe, expect, test } from "bun:test";
import { SAVE_DELAY } from "../web/src/lib/notes";

/** The server side: a note per id, saved only from the version it is actually at. */
class Store {
  notes = new Map<string, { body: string; updatedAt: number }>();
  saves: { id: string; body: string; base: number }[] = [];
  /** Answer every save after this many turns (a real socket is not instant). */
  delay = 0;
  version(id: string) {
    return this.notes.get(id)?.updatedAt ?? 0;
  }
  save(id: string, body: string, base: number): Promise<{ ok: true; note: { id: string; body: string; updatedAt: number } } | { ok: false; conflict: { id: string; body: string; updatedAt: number } }> {
    this.saves.push({ id, body, base });
    const apply = () => {
      if (base !== this.version(id)) return { ok: false as const, conflict: { id, body: this.notes.get(id)?.body ?? "", updatedAt: this.version(id) } };
      // Every save is a new version, even two in the same millisecond.
      const updatedAt = this.version(id) + 1;
      this.notes.set(id, { body, updatedAt });
      return { ok: true as const, note: { id, body, updatedAt } };
    };
    if (!this.delay) return Promise.resolve(apply());
    return new Promise((res) => setTimeout(() => res(apply()), this.delay));
  }
  body(id: string) {
    return this.notes.get(id)?.body ?? "";
  }
}

/** The editor state the panel keeps, with the same fields `flush()` reads. */
function editor(store: Store, noteId: string | null) {
  let body = "";
  let savedBody = "";
  let base = 0;
  let save: { kind: string } = { kind: "loading" };
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const landed = new Map<string, number>();

  /** Load the note's current value, as the watch does when the panel opens. */
  const load = (id: string) => {
    body = savedBody = store.body(id);
    base = store.version(id);
    landed.set(id, base);
    save = { kind: "saved" };
  };
  const type = (text: string) => {
    if (!noteId) throw new Error("a pane with no session has nowhere to keep notes");
    body = text;
    save = { kind: "dirty" };
    clearTimeout(timer);
    timer = setTimeout(() => void flush(noteId!), SAVE_DELAY);
  };
  const setNote = (id: string | null) => (noteId = id);

  async function flush(id: string, leaving = false): Promise<void> {
    clearTimeout(timer);
    const snap = { text: body, saved: savedBody, base, kind: save.kind };
    const wanted = snap.text;
    if (inFlight) await inFlight;
    const current = id === noteId && !leaving;
    const text = current ? body : snap.text;
    const saved = current ? savedBody : snap.saved;
    const kind = current ? save.kind : snap.kind;
    const from = landed.get(id) ?? snap.base;
    if (text === saved || kind === "conflict" || kind === "loading") return;
    if (current) save = { kind: "saving" };
    const run = (async () => {
      const result = await store.save(id, text, from);
      if (result.ok) landed.set(id, result.note.updatedAt);
      if (id !== noteId) return;
      if (result.ok) {
        base = result.note.updatedAt;
        savedBody = text;
        save = { kind: "saved" };
      } else {
        save = { kind: "conflict" };
      }
    })();
    inFlight = run;
    await run;
    if (inFlight === run) inFlight = null;
    // Still showing this note, and it moved on while this flush waited its turn: save it again.
    if (current && !leaving && id === noteId && body !== wanted && body !== savedBody) timer = setTimeout(() => void flush(id), 0);
  }

  /** What the panel's effect does: flush what is pending, then the next run resets the editor. */
  const leave = async (id: string, to: string | null) => {
    const pending = flush(id, true);
    noteId = to;
    await pending;
    clearTimeout(timer); // the new effect run replaces the editor; the old debounce is gone
  };
  return { type, load, flush, leave, setNote, get noteId() { return noteId; }, get body() { return body; }, get save() { return save; } };
}

describe("the notes editor's save queue", () => {
  test("a note is saved under the version it was loaded at", async () => {
    const store = new Store();
    const e = editor(store, "s-1");
    e.load("s-1");
    e.type("first version");
    await e.flush("s-1");
    expect(store.body("s-1")).toBe("first version");
    expect(store.version("s-1")).toBe(1);
  });

  test("nothing to save means nothing is sent", async () => {
    const store = new Store();
    const e = editor(store, "s-1");
    e.load("s-1");
    await e.flush("s-1");
    expect(store.saves).toHaveLength(0);
  });

  test("text typed while a save is in flight is not lost when the pane switches away", async () => {
    // The bug: the leaving flush named the version from before the in-flight save landed, so the
    // server refused it as a conflict and the newer text was silently dropped.
    const store = new Store();
    store.delay = 5;
    const e = editor(store, "s-alpha");
    e.load("s-alpha");

    e.type("v1");                              // the autosave goes out and is in flight
    const first = e.flush("s-alpha");
    e.type("v2 typed during the save");        // typed before the answer came back
    const leaving = e.leave("s-alpha", "s-beta"); // the pane switches to another session
    await Promise.all([first, leaving]);

    expect(store.body("s-alpha")).toBe("v2 typed during the save");
    // Both saves landed, each naming the version before it: never a stale base that is refused.
    expect(store.saves.map((s) => s.body)).toEqual(["v1", "v2 typed during the save"]);
    expect(store.saves.map((s) => s.base)).toEqual([0, 1]);
    expect(store.version("s-alpha")).toBe(2);
  });

  test("a save still lands when the pane closes with the note unsaved", async () => {
    const store = new Store();
    store.delay = 3;
    const e = editor(store, "s-1");
    e.load("s-1");
    e.type("never saved by the debounce");
    await e.leave("s-1", null); // the pane is gone entirely
    expect(store.body("s-1")).toBe("never saved by the debounce");
  });

  test("several flushes in a row all land, each naming the version before it", async () => {
    const store = new Store();
    store.delay = 2;
    const e = editor(store, "s-1");
    e.load("s-1");
    for (const text of ["one", "two", "three"]) {
      e.type(text);
      await e.flush("s-1");
    }
    expect(store.body("s-1")).toBe("three");
    expect(store.version("s-1")).toBe(3);
  });

  test("two notes in one pane each keep their own version", async () => {
    const store = new Store();
    const e = editor(store, "s-a");
    e.load("s-a");
    e.type("alpha words");
    await e.flush("s-a");
    // The pane switches to another session and back; each note starts from its own version.
    e.setNote("s-b");
    e.load("s-b");
    e.type("beta words");
    await e.flush("s-b");
    e.setNote("s-a");
    await e.leave("s-a", "s-b");
    expect(store.body("s-a")).toBe("alpha words");
    expect(store.body("s-b")).toBe("beta words");
  });

  test("a save from a stale version is reported as a conflict, not silently applied", async () => {
    // Somebody else saved in between: the save names the version it started at, so it is refused
    // and the editor says so instead of overwriting their text.
    const store = new Store();
    const e = editor(store, "s-1");
    e.load("s-1");
    store.save("s-1", "from another tab", 0); // another tab gets there first
    e.type("mine");
    await e.flush("s-1");
    expect(store.body("s-1")).toBe("from another tab");
    expect(e.save.kind).toBe("conflict");
  });
});
