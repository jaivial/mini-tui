import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { describe, expect, test } from "bun:test";

import {
  PAGE_SIZE,
  countSessions,
  createSession,
  fallbackTitle,
  getSession,
  listSessions,
  openDb,
  saveTranscript,
  updateSession,
  writeResumeFile,
} from "../src/sessions";

const DB = join(import.meta.dir, ".tmp-sessions-db.sqlite");

describe("session store", () => {
  test("fallbackTitle trims the prompt to a readable length", () => {
    expect(fallbackTitle("fix the bug")).toBe("fix the bug");
    const long = fallbackTitle("x".repeat(80));
    expect(long.length).toBe(48);
    expect(long.endsWith("…")).toBe(true);
    expect(fallbackTitle("  spaced   out  ")).toBe("spaced out");
  });

  test("sessions are stored per working path and searchable by title", () => {
    rmSync(DB, { force: true });
    const db = openDb(DB);
    createSession(db, { id: "a1", cwd: "/proj/a", model: "xiaomi/mimo-v2.6-pro", task: "fix tax", title: "Fix tax calculation" });
    createSession(db, { id: "a2", cwd: "/proj/a", model: "m", task: "add pagination" });
    createSession(db, { id: "b1", cwd: "/proj/b", model: "m", task: "other folder work", title: "Other folder work" });

    // cwd filter: another folder's sessions never leak in
    expect(countSessions(db, "/proj/a", "")).toBe(2);
    expect(listSessions(db, "/proj/a", "", 0).map((s) => s.id).sort()).toEqual(["a1", "a2"]);
    expect(listSessions(db, "/proj/b", "", 0).map((s) => s.id)).toEqual(["b1"]);

    // title search (fallback title = trimmed prompt)
    expect(listSessions(db, "/proj/a", "paginat", 0).map((s) => s.id)).toEqual(["a2"]);
    expect(listSessions(db, "/proj/a", "FIX TAX", 0).map((s) => s.id)).toEqual(["a1"]);
    expect(countSessions(db, "/proj/a", "zzz")).toBe(0);
    db.close();
    rmSync(DB, { force: true });
  });

  test("transcripts and stats are saved and pages come back newest first", () => {
    rmSync(DB, { force: true });
    const db = openDb(DB);
    for (let i = 0; i < PAGE_SIZE + 2; i++) {
      createSession(db, { id: `s${i}`, cwd: "/proj", model: "m", task: `task ${i}`, title: `Session ${i}` });
      updateSession(db, `s${i}`, { api_calls: i, cost: i * 0.5 });
      saveTranscript(db, `s${i}`, [{ type: "task", text: `task ${i}` }], { cost: i * 0.5, apiCalls: i });
    }
    expect(countSessions(db, "/proj", "")).toBe(PAGE_SIZE + 2);
    const page0 = listSessions(db, "/proj", "", 0);
    const page1 = listSessions(db, "/proj", "", 1);
    expect(page0.length).toBe(PAGE_SIZE);
    expect(page1.length).toBe(2);

    const record = getSession(db, "s3");
    expect(record?.api_calls).toBe(3);
    expect(record?.cost).toBe(1.5);
    expect(JSON.parse(record?.events_json ?? "[]")).toEqual([{ type: "task", text: "task 3" }]);
    db.close();
    rmSync(DB, { force: true });
  });
});

describe("resume context", () => {
  test("raw messages round-trip through the store and the resume file", () => {
    rmSync(DB, { force: true });
    const db = openDb(DB);
    createSession(db, { id: "r1", cwd: "/proj", model: "m", task: "hello" });
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi", extra: { actions: [{ command: "ls", tool_call_id: "c1" }] } },
    ];
    saveTranscript(db, "r1", [{ type: "task", text: "hello" }], { cost: 0, apiCalls: 1 }, messages);
    const record = getSession(db, "r1");
    expect(JSON.parse(record?.messages_json ?? "[]")).toEqual(messages);

    const path = writeResumeFile("r1", messages);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ messages });
    rmSync(path, { force: true });
    db.close();
    rmSync(DB, { force: true });
  });

  test("old databases gain the messages column (empty history)", () => {
    rmSync(DB, { force: true });
    const raw = new Database(DB, { create: true });
    raw.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, cwd TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, api_calls INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, exit_status TEXT NOT NULL DEFAULT '', events_json TEXT NOT NULL DEFAULT '[]', info_json TEXT NOT NULL DEFAULT '{}')");
    raw.query("INSERT INTO sessions (id, title, cwd, created_at, updated_at) VALUES ('old', 'Old', '/p', 1, 1)").run();
    raw.close();
    const db = openDb(DB);
    expect(getSession(db, "old")?.messages_json).toBe("[]");
    db.close();
    rmSync(DB, { force: true });
  });
});
