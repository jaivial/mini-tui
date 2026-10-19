/**
 * The notes editor's save machine, as it really is: these tests drive `web/src/lib/noteEditor.ts`,
 * the code `NotesPanel.svelte` runs in the browser. They used to drive a hand-written **model** of
 * that panel ("when that function changes, this model must change with it"), and the model had
 * already drifted: it had no error state at all (a save that failed threw in the test and set an
 * error in the panel) and it reported "saved" while the user was still typing. A copy that nobody
 * forces to agree is E50's pattern — so there is no copy now, and the rules that decide what a save
 * sends are exercised where they live.
 *
 * The verdicts under test all follow one rule: the panel may never claim something it cannot make
 * true. "Not saved" for a write that is in the database, and "changed somewhere else" for the
 * editor's own text coming back, are both claims about the world — measured wrong on the deployed
 * build (2026-10-19, `evidencia/2026-10-19_E51/ANTES-e2e.txt`).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NoteEditor, type SaveFn } from "../web/src/lib/noteEditor";
import type { NoteSave } from "../web/src/lib/notesClient";
import type { Note } from "../web/src/lib/types";

/** The server side: a note per id, saved only from the version it is actually at. */
class Store {
  notes = new Map<string, { body: string; updatedAt: number }>();
  saves: { id: string; body: string; base: number }[] = [];
  /** Answer every save after this many turns (a real socket is not instant). */
  delay = 0;
  version(id: string) {
    return this.notes.get(id)?.updatedAt ?? 0;
  }
  save: SaveFn = (id, body, base) => {
    this.saves.push({ id, body, base });
    const apply = (): NoteSave => {
      if (base !== this.version(id)) return { ok: false, conflict: this.at(id) };
      // Every save is a new version, even two in the same millisecond.
      const updatedAt = this.version(id) + 1;
      this.notes.set(id, { body, updatedAt });
      return { ok: true, note: this.at(id) };
    };
    if (!this.delay) return Promise.resolve(apply());
    return new Promise((res) => setTimeout(() => res(apply()), this.delay));
  };
  /** What the server would answer a watch with, right now. */
  at(id: string): Note {
    return { id, body: this.notes.get(id)?.body ?? "", updatedAt: this.version(id) };
  }
  body(id: string) {
    return this.notes.get(id)?.body ?? "";
  }
}

/** Wire the real machine to the fake server, the way `NotesPanel.svelte` wires it. */
function editor(store: Store, noteId: string | null, save: SaveFn = store.save): NoteEditor {
  const ed = new NoteEditor(save);
  ed.enter(noteId);
  return ed;
}

/** The panel's watch: the server hands the note over as its current value. */
const load = (ed: NoteEditor, store: Store, id: string) => ed.applyRemote(id, store.at(id));

/**
 * A pane switching notes the way a Svelte `$effect` does: the previous run's cleanup (the leaving
 * flush) starts *first*, then the new run's body resets the editor for the note on screen. The
 * leaving flush therefore reads the tracked version before `enter` clears it — this order is what
 * keeps the old note's text alive across the switch.
 */
async function switchNote(ed: NoteEditor, from: string, to: string | null) {
  const leaving = ed.leave(from);
  ed.enter(to);
  await leaving;
}

describe("the notes editor's save queue", () => {
  test("a note is saved under the version it was loaded at", async () => {
    const store = new Store();
    const e = editor(store, "s-1");
    load(e, store, "s-1");
    e.type("first version");
    await e.flush("s-1");
    expect(store.body("s-1")).toBe("first version");
    expect(store.version("s-1")).toBe(1);
  });

  test("nothing to save means nothing is sent", async () => {
    const store = new Store();
    const e = editor(store, "s-1");
    load(e, store, "s-1");
    await e.flush("s-1");
    expect(store.saves).toHaveLength(0);
  });

  test("text typed while a save is in flight is not lost when the pane switches away", async () => {
    // The bug: the leaving flush named the version from before the in-flight save landed, so the
    // server refused it as a conflict and the newer text was silently dropped.
    const store = new Store();
    store.delay = 5;
    const e = editor(store, "s-alpha");
    load(e, store, "s-alpha");

    e.type("v1"); // the autosave goes out and is in flight
    const first = e.flush("s-alpha");
    e.type("v2 typed during the save"); // typed before the answer came back
    const leaving = e.leave("s-alpha"); // the pane switches to another session
    e.enter("s-beta");
    await Promise.all([first, leaving]);

    expect(store.body("s-alpha")).toBe("v2 typed during the save");
    // Both saves landed, each naming the version before it: never a stale base that is refused.
    expect(store.saves.map((s) => s.body)).toEqual(["v1", "v2 typed during the save"]);
    expect(store.saves.map((s) => s.base)).toEqual([0, 1]);
    expect(store.version("s-alpha")).toBe(2);
  });

  test("switching notes the way a Svelte effect does keeps the old note's text", async () => {
    const store = new Store();
    store.delay = 5;
    const e = editor(store, "s-alpha");
    load(e, store, "s-alpha");
    e.type("alpha in flight");
    const first = e.flush("s-alpha");
    e.type("alpha typed during the save");
    await switchNote(e, "s-alpha", "s-beta");
    await first;
    expect(store.body("s-alpha")).toBe("alpha typed during the save");
  });

  test("a save still lands when the pane closes with the note unsaved", async () => {
    const store = new Store();
    store.delay = 3;
    const e = editor(store, "s-1");
    load(e, store, "s-1");
    e.type("never saved by the debounce");
    await switchNote(e, "s-1", null); // the pane is gone entirely
    expect(store.body("s-1")).toBe("never saved by the debounce");
  });

  test("several flushes in a row all land, each naming the version before it", async () => {
    const store = new Store();
    store.delay = 2;
    const e = editor(store, "s-1");
    load(e, store, "s-1");
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
    load(e, store, "s-a");
    e.type("alpha words");
    await e.flush("s-a");
    // The pane switches to another session and back; each note starts from its own version.
    await switchNote(e, "s-a", "s-b");
    load(e, store, "s-b");
    e.type("beta words");
    await e.flush("s-b");
    await switchNote(e, "s-b", "s-a");
    expect(store.body("s-a")).toBe("alpha words");
    expect(store.body("s-b")).toBe("beta words");
  });

  test("resolving a conflict by keeping my text saves it, not conflicts again", async () => {
    // Another tab saved first, so our save is refused and the editor offers the choice. Choosing
    // "keep mine" must overwrite deliberately from *their* version: from a stale one it would be
    // refused again and the text would never land.
    const store = new Store();
    const e = editor(store, "s-1");
    load(e, store, "s-1");
    store.save("s-1", "from another tab", 0);
    e.type("mine");
    await e.flush("s-1");
    expect(e.save.kind).toBe("conflict");
    await e.keepMine();
    expect(store.body("s-1")).toBe("mine");
    expect(e.save.kind).toBe("saved");
  });

  test("resolving a conflict by taking theirs needs no save at all", async () => {
    const store = new Store();
    const e = editor(store, "s-1");
    load(e, store, "s-1");
    store.save("s-1", "from another tab", 0);
    e.type("mine");
    await e.flush("s-1");
    e.takeTheirs();
    expect(e.save.kind).toBe("saved");
    expect(store.body("s-1")).toBe("from another tab"); // theirs was already on the server
  });

  test("a note's version is forgotten once the pane stops watching it", async () => {
    // A long-lived pane that switches between many sessions must not hold a version for each of
    // them forever: only the note on screen is tracked.
    const store = new Store();
    const e = editor(store, "s-1");
    for (let i = 0; i < 40; i++) {
      const id = `s-${i}`;
      await switchNote(e, e.noteId!, id);
      load(e, store, id);
      e.type(`words for ${id}`);
      await e.flush(id);
    }
    expect(e.tracked()).toBe(1);
  });

  test("a save from a stale version is reported as a conflict, not silently applied", async () => {
    // Somebody else saved in between: the save names the version it started at, so it is refused
    // and the editor says so instead of overwriting their text.
    const store = new Store();
    const e = editor(store, "s-1");
    load(e, store, "s-1");
    store.save("s-1", "from another tab", 0); // another tab gets there first
    e.type("mine");
    await e.flush("s-1");
    expect(store.body("s-1")).toBe("from another tab");
    expect(e.save.kind).toBe("conflict");
  });
});

describe("a save the app never saw land", () => {
  /** A save the deadline gives up on: the promise rejects while the write lands anyway. */
  function deadlineGivesUp(store: Store, landed: { note?: Note }): SaveFn {
    return (id, body, base) => {
      void store.save(id, body, base).then((r) => {
        if (r.ok) landed.note = r.note;
      });
      return Promise.reject(new Error("no answer from the server (the save may still be applied)"));
    };
  }

  test("the panel stops saying 'not saved' when the save it gave up on lands", async () => {
    // The whole lie, measured on the deployed build: the answer arrived 18 s after the 15 s
    // deadline, the write was in the database, and the panel still said "Not saved" — for ever.
    const store = new Store();
    const landed: { note?: Note } = {};
    const e = editor(store, "s-1", deadlineGivesUp(store, landed));
    load(e, store, "s-1");
    e.type("the answer arrives after the panel gave up");
    await e.flush("s-1");
    expect(e.save.kind).toBe("error"); // what the deadline could honestly say at that moment
    // ...and then the answer lands (what `NotesClient` does with it: `onLateSave`).
    e.applyLate(landed.note!, "saved");
    expect(e.save.kind).toBe("saved");
    expect(store.body("s-1")).toBe("the answer arrives after the panel gave up");
  });

  test("a late save that landed while the editor had typed on leaves the new text unsaved", async () => {
    const store = new Store();
    const landed: { note?: Note } = {};
    const e = editor(store, "s-1", deadlineGivesUp(store, landed));
    load(e, store, "s-1");
    e.type("what the late save carried");
    await e.flush("s-1");
    e.type("typed after the deadline");
    e.applyLate(landed.note!, "saved");
    expect(e.save.kind).toBe("dirty"); // the server has the old text; this one is still unsaved
    expect(e.savedBody).toBe("what the late save carried");
  });

  test("a late answer that was refused is a conflict, and the next save names its version", async () => {
    // Not only 'saved' answers arrive late. A refusal moves the note on too: the book must learn its
    // version or the next save is refused again for a change nobody made.
    const store = new Store();
    store.save("s-1", "from another tab", 0); // v1 there first
    const e = editor(store, "s-1", () => Promise.reject(new Error("no answer from the server (the save may still be applied)")));
    load(e, store, "s-1");
    e.type("mine");
    await e.flush("s-1");
    expect(e.save.kind).toBe("error");
    e.applyLate(store.at("s-1"), "conflict");
    expect(e.save.kind).toBe("conflict");
    expect(e.save).toMatchObject({ theirs: "from another tab", theirsAt: 1 });
  });

  test("a save that landed after the app gave up must not poison the next one with a false conflict", async () => {
    // The deadline fired while the save was out (its verdict: "may still be applied"). It landed as
    // v1 and the editor never got the answer, so the next save must name v1 or the server refuses it
    // as a conflict for a change that is the editor's own — measured before the fix: `conflict`, and
    // the typed text was dropped on the floor.
    const store = new Store();
    const e = editor(store, "s-1");
    load(e, store, "s-1");
    e.type("typed before the deadline");
    void store.save("s-1", "typed before the deadline", 0); // lands as v1, out of band
    e.applyLate(store.at("s-1"), "saved");
    e.type("typed after the error");
    await e.flush("s-1");
    expect(e.save.kind).toBe("saved");
    expect(store.saves.at(-1)!.base).toBe(1);
    expect(store.body("s-1")).toBe("typed after the error");
    expect(store.version("s-1")).toBe(2);
  });

  test("a failed save whose text is already on the server does not say 'not saved'", async () => {
    // The reconnect catch-up (below) already told the editor the server holds its text; the save's
    // own answer never came. Saying "Not saved" here is refuted by the database.
    const store = new Store();
    const e = editor(store, "s-1", () => Promise.reject(new Error("no answer from the server (the save may still be applied)")));
    load(e, store, "s-1");
    e.type("landed while the answer was lost");
    const run = e.flush("s-1");
    // The catch-up after a reconnect: the server hands the note back with the editor's own text.
    store.notes.set("s-1", { body: "landed while the answer was lost", updatedAt: 1 });
    e.applyRemote("s-1", store.at("s-1"));
    await run;
    expect(e.save.kind).toBe("saved");
  });
});

describe("the editor's own text coming back", () => {
  test("a catch-up with the editor's own text is not 'changed somewhere else'", async () => {
    // The measured lie, in full (the e2e replays it against the deployed build): the save goes out,
    // its answer is lost with the socket, the hub reconnects and the server hands the note back as
    // the catch-up it does for every watch — with the editor's OWN text, at a version the editor
    // never heard of. The panel called that "These notes were saved from another tab or device while
    // you were typing" and asked the reader to choose between two identical texts.
    const store = new Store();
    const e = editor(store, "s-1", () => Promise.reject(new Error("no answer from the server (the save may still be applied)")));
    load(e, store, "s-1"); // empty, v0
    e.type("saved here, seen from there");
    const run = e.flush("s-1"); // goes out; its answer never comes
    store.notes.set("s-1", { body: "saved here, seen from there", updatedAt: 1 }); // it landed
    const what = e.applyRemote("s-1", store.at("s-1")); // the hub's catch-up after the reconnect
    expect(what).not.toBe("conflict");
    expect(e.save.kind).not.toBe("conflict"); // no banner between the catch-up and the verdict below
    await run;
    expect(e.save.kind).toBe("saved");
  });

  test("a push of the editor's own text while it is still marked unsaved is not a conflict either", async () => {
    const store = new Store();
    const e = editor(store, "s-1");
    load(e, store, "s-1");
    e.type("exactly this");
    store.notes.set("s-1", { body: "exactly this", updatedAt: 1 }); // it landed, somewhere
    const what = e.applyRemote("s-1", store.at("s-1"));
    expect(what).not.toBe("conflict");
    expect(e.save.kind).toBe("saved");
    expect(e.base).toBe(1); // and the next save starts from what the server is at
  });

  test("a refusal that carries the text it refused is not a conflict", async () => {
    // What a late answer of our own save looks like from the outside: the server refuses the save
    // because it already holds exactly that text at another version.
    const store = new Store();
    const e = editor(store, "s-1", () => Promise.resolve({ ok: false, conflict: { id: "s-1", body: "mine", updatedAt: 1 } }));
    load(e, store, "s-1"); // the note is empty here, v0
    e.type("mine");
    await e.flush("s-1"); // refused — but the refusal carries the very text it refused
    expect(e.save.kind).toBe("saved");
    expect(e.base).toBe(1);
  });

  test("a real conflict is still a conflict", async () => {
    const store = new Store();
    const e = editor(store, "s-1");
    load(e, store, "s-1");
    store.save("s-1", "from another tab", 0);
    e.type("mine");
    expect(e.applyRemote("s-1", store.at("s-1"))).toBe("conflict");
    expect(e.save).toMatchObject({ kind: "conflict", theirs: "from another tab" });
  });
});

describe("a note cleared from somewhere else", () => {
  test("keep mine must be able to save it — no conflict loop", async () => {
    // An empty body DELETES the note and the server's version goes back to 0 (src/sessions.ts).
    // The editor's book still remembers the version its own save established (1000): if the
    // version the next save names is taken as max(landed, book), it names 1000 against a server
    // at 0 and every 'keep mine' conflicts again forever (review finding R1).
    const store = new Store();
    const e = editor(store, "s-1");
    load(e, store, "s-1");
    e.type("mine");
    await e.flush("s-1"); // v1 ... made v1000 below out of band
    e.applyLate({ id: "s-1", body: "mine", updatedAt: 1000 }, "saved");
    store.notes.set("s-1", { body: "", updatedAt: 0 }); // cleared elsewhere: the version fell to 0
    e.type("mine again");
    await e.flush("s-1"); // refused: the editor names 1000, the server is at 0
    expect(e.save.kind).toBe("conflict");
    await e.keepMine(); // the user chooses their text
    expect(e.save.kind).toBe("saved");
    expect(store.body("s-1")).toBe("mine again");
    expect(store.saves.at(-1)!.base).toBe(0);
  });
});

describe("one copy of these rules (E50's pattern)", () => {
  const lib = join(import.meta.dir, "..", "web", "src", "lib");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const files = walk(lib).filter((f) => /\.(ts|svelte)$/.test(f));

  test("the autosave timer lives in one place, and the panel owns no save logic", () => {
    // The tests used to hold a hand-written copy of `flush()` — it drifted from the panel and
    // nothing said so. The rule that keeps a copy from coming back: the panel wires the machine and
    // shows what it says, and every scheduling rule is `noteEditor`'s.
    const withDelay = files.filter((f) => readFileSync(f, "utf8").includes("SAVE_DELAY"));
    expect(withDelay.map((f) => f.split("/lib/")[1]).sort()).toEqual(["notes.ts", "noteEditor.ts"]);
    const panel = readFileSync(join(lib, "components", "NotesPanel.svelte"), "utf8");
    for (const forbidden of ["SAVE_DELAY", "notes.save", "saveDeadlineMs", 'kind: "', "landed"]) {
      expect(panel).not.toContain(forbidden);
    }
    expect(panel).toContain("NoteEditor");
    expect(panel).toContain("onLateSave"); // the verdict is corrected when a save it gave up on lands
  });
});
