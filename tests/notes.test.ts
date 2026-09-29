/** Session notes: stored beside the history, never lost to a concurrent save, gone with their session. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const dir = mkdtempSync(join(tmpdir(), "minitui-notes-"));
const savedResume = process.env.MINITUI_RESUME_DIR;
process.env.MINITUI_RESUME_DIR = join(dir, "resume");
const { createSession, deleteSession, getNote, openDb, saveNote, listHistory, NOTE_MAX } = await import("../src/sessions");
afterAll(() => {
  if (savedResume === undefined) delete process.env.MINITUI_RESUME_DIR;
  else process.env.MINITUI_RESUME_DIR = savedResume;
  rmSync(dir, { recursive: true, force: true });
});

const fresh = () => openDb(join(dir, `${crypto.randomUUID()}.db`));

describe("notes", () => {
  test("a session with no note reads as empty, version 0", () => {
    expect(getNote(fresh(), "s-1")).toEqual({ id: "s-1", body: "", updatedAt: 0 });
  });

  test("a save round-trips, text exactly as written (unicode, newlines, markdown)", () => {
    const db = fresh();
    const body = "# plan\n\n- [ ] ñandú 🦤\n\t indented\r\nwindows line\n";
    const saved = saveNote(db, "s-1", body, 0);
    expect(saved.ok).toBe(true);
    expect(getNote(db, "s-1").body).toBe(body);
  });

  test("a save from a stale version is refused and returns the newer note, which is kept", () => {
    const db = fresh();
    const first = saveNote(db, "s-1", "from tab A", 0);
    if (!first.ok) throw new Error("first save failed");
    const tabB = saveNote(db, "s-1", "from tab B", first.note.updatedAt);
    expect(tabB.ok).toBe(true);
    // tab A still thinks the note is at `first`: its next save must not silently erase tab B's text
    const tabA = saveNote(db, "s-1", "tab A again", first.note.updatedAt);
    expect(tabA.ok).toBe(false);
    if (!tabA.ok) expect(tabA.conflict.body).toBe("from tab B");
    expect(getNote(db, "s-1").body).toBe("from tab B");
  });

  test("two saves in the same millisecond still get different versions", () => {
    const db = fresh();
    const versions = new Set<number>();
    let base = 0;
    for (let i = 0; i < 50; i++) {
      const r = saveNote(db, "s-1", `v${i}`, base);
      if (!r.ok) throw new Error(`save ${i} conflicted`);
      versions.add(r.note.updatedAt);
      base = r.note.updatedAt;
    }
    expect(versions.size).toBe(50);
  });

  test("clearing a note removes it (empty and absent are the same)", () => {
    const db = fresh();
    const r = saveNote(db, "s-1", "something", 0);
    if (!r.ok) throw new Error();
    expect(saveNote(db, "s-1", "", r.note.updatedAt).ok).toBe(true);
    expect(getNote(db, "s-1")).toEqual({ id: "s-1", body: "", updatedAt: 0 });
    expect((db.query("SELECT count(*) AS n FROM notes").get() as { n: number }).n).toBe(0);
  });

  test("a note needs no session row (a remote run has none until it ends)", () => {
    const db = fresh();
    expect(saveNote(db, "s-remote-running", "notes while it runs").ok).toBe(true);
    expect(getNote(db, "s-remote-running").body).toBe("notes while it runs");
  });

  test("deleting a session deletes its note; other sessions' notes stay", () => {
    const db = fresh();
    createSession(db, { id: "s-a", cwd: "/w", model: "m", task: "a" });
    createSession(db, { id: "s-b", cwd: "/w", model: "m", task: "b" });
    saveNote(db, "s-a", "note a");
    saveNote(db, "s-b", "note b");
    deleteSession(db, "s-a");
    expect(getNote(db, "s-a").body).toBe("");
    expect(getNote(db, "s-b").body).toBe("note b");
  });

  test("notes never slow the history listing: it does not read them", () => {
    const db = fresh();
    createSession(db, { id: "s-a", cwd: "/w", model: "m", task: "a" });
    saveNote(db, "s-a", "x".repeat(NOTE_MAX));
    const row = listHistory(db)[0] as Record<string, unknown>;
    expect(Object.keys(row).some((k) => /note/i.test(k))).toBe(false);
  });

  test("a database from before notes existed gains the table on open, and keeps its sessions", () => {
    const path = join(dir, "old.db");
    const old = new Database(path, { create: true });
    old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, cwd TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, api_calls INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, exit_status TEXT NOT NULL DEFAULT '',
      events_json TEXT NOT NULL DEFAULT '[]', info_json TEXT NOT NULL DEFAULT '{}', messages_json TEXT NOT NULL DEFAULT '[]');
      INSERT INTO sessions (id, title, cwd, created_at, updated_at) VALUES ('s-old', 'Old', '/w', 1, 1);`);
    old.close();
    const db = openDb(path);
    expect(listHistory(db).map((r) => r.id)).toEqual(["s-old"]);
    expect(saveNote(db, "s-old", "added later").ok).toBe(true);
  });
});
