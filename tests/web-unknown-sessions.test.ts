/**
 * E52: "not in my list" is not "it is gone". The workspace is shared by every tab and device, the
 * session LIST each client holds is not: a tab whose panes show a session it has never loaded must
 * ASK the server, and only the server's own "I do not hold it" (404) may turn the pane into a new
 * chat. The bug this pins: an idle tab read "not in my list" as "deleted", cleared the pane and
 * wrote that into the shared workspace, undoing the click in the tab that made it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FLIGHT_MS, UnknownSessions, isNowhere, unknown as appBook } from "../web/src/lib/unknownSessions";

describe("UnknownSessions: an unknown session is asked about, never guessed", () => {
  test("a shown session this client has not loaded is picked; a known one is not", () => {
    const u = new UnknownSessions();
    expect(u.pick(["s-a", "s-b", "s-a"], (id) => id === "s-a")).toEqual(["s-b"]);
    expect(u.pick(["s-a"], (id) => id === "s-a")).toEqual([]);
    expect(u.asking("s-b")).toBe(true);
  });

  test("the same id is not asked twice while the question is in flight", () => {
    const u = new UnknownSessions();
    expect(u.pick(["s-a"], () => false)).toEqual(["s-a"]);
    expect(u.pick(["s-a", "s-a"], () => false)).toEqual([]);
    expect(u.asking("s-a")).toBe(true);
  });

  test("an answer that proves nothing (a failed call) frees the id to be asked again", () => {
    const u = new UnknownSessions();
    u.pick(["s-a"], () => false);
    u.answer(["s-a"], []); // 503 / network error: no verdict
    expect(u.isGone("s-a")).toBe(false);
    expect(u.asking("s-a")).toBe(false);
    expect(u.pick(["s-a"], () => false)).toEqual(["s-a"]);
  });

  test("the server's 'I do not hold it' forgets the session and is never asked again", () => {
    const u = new UnknownSessions();
    u.pick(["s-a"], () => false);
    u.answer(["s-a"], ["s-a"]);
    expect(u.isGone("s-a")).toBe(true);
    expect(u.pick(["s-a"], () => false)).toEqual([]);
    expect(u.asking("s-a")).toBe(false);
  });

  test("the server's own announcement is a verdict (closing keeps the row: asking would re-open it)", () => {
    const u = new UnknownSessions();
    expect(u.pick(["s-a"], () => false)).toEqual(["s-a"]);
    u.confirmGone("s-a"); // `session-gone`, or this tab closed it
    expect(u.isGone("s-a")).toBe(true);
    expect(u.pick(["s-a"], () => false)).toEqual([]); // never asked: `openHistory` would re-open it
  });

  test("a verdict is revoked when the session is seen again (ids can come back)", () => {
    const u = new UnknownSessions();
    u.confirmGone("s-a");
    u.resurrect("s-a"); // loaded, restored or announced again
    expect(u.isGone("s-a")).toBe(false);
    expect(u.pick(["s-a"], () => false)).toEqual(["s-a"]);
  });

  test("a question older than the flight window is askable again (a fetch that never settles)", () => {
    const u = new UnknownSessions();
    expect(u.pick(["s-a"], () => false, 1000)).toEqual(["s-a"]);
    expect(u.pick(["s-a"], () => false, 1000 + FLIGHT_MS - 1)).toEqual([]);
    expect(u.pick(["s-a"], () => false, 1000 + FLIGHT_MS)).toEqual(["s-a"]);
  });

  test("the app has one book: the store reports verdicts into the same one App asks", () => {
    expect(appBook).toBeInstanceOf(UnknownSessions);
  });

  test("a session that turns up known later needs no question at all", () => {
    const u = new UnknownSessions();
    const known = new Set<string>();
    expect(u.pick(["s-a"], (id) => known.has(id))).toEqual(["s-a"]);
    u.answer(["s-a"], []); // the call failed; meanwhile the tab learned about it another way
    known.add("s-a");
    expect(u.pick(["s-a"], (id) => known.has(id))).toEqual([]);
    expect(u.isGone("s-a")).toBe(false);
  });
});

describe("isNowhere: only the server's own 404 forgets a session", () => {
  test("404 is the verdict", () => {
    expect(isNowhere(Object.assign(new Error("unknown session"), { status: 404 }))).toBe(true);
    expect(isNowhere({ status: 404 })).toBe(true);
  });
  test("a failure to ASK is not an answer", () => {
    expect(isNowhere(Object.assign(new Error("could not open the session: db busy"), { status: 503 }))).toBe(false);
    expect(isNowhere(new Error("fetch failed"))).toBe(false); // a network error carries no status
    expect(isNowhere(null)).toBe(false);
    expect(isNowhere(undefined)).toBe(false);
    expect(isNowhere("404")).toBe(false);
    expect(isNowhere({ status: "404" })).toBe(false); // a string status is not a status
  });
});

describe("guards: the guess must not come back", () => {
  const app = readFileSync(join(import.meta.dir, "..", "web", "src", "App.svelte"), "utf8");
  const sessions = readFileSync(join(import.meta.dir, "..", "web", "src", "lib", "stores", "sessions.svelte.ts"), "utf8");
  const api = readFileSync(join(import.meta.dir, "..", "web", "src", "lib", "api.ts"), "utf8");

  test("App.svelte never forgets a session on its own list ('not in my list' as 'gone')", () => {
    // The E52 shape: the verdict read straight from this client's store.
    expect(app).not.toMatch(/forgetMissing\(\(id\) => !!store\.sessions\[id\]\)/);
    expect(app).not.toMatch(/forgetMissing\(\(id\) => !store\.sessions\[id\]\)/);
    // Every forget names a verdict the app can make real: the server's "nowhere", or its own
    // delete/close of that exact session.
    for (const line of app.split("\n").filter((l) => l.includes("forgetMissing("))) {
      expect(line).toMatch(/unknown\.isGone\(id\)|id !== |sid !== /);
    }
  });

  test("App.svelte asks about the sessions it has not loaded (the only way to know)", () => {
    expect(app).toContain("unknown.pick(panes.shown");
    expect(app).toContain("store.restore(ask)");
  });

  test("the verdict sweep runs on every answer, not only when a question found one", () => {
    // The regression this pins: a pane can start showing an id this tab ALREADY learned is gone (a
    // window coming back from the shelf), with no question left to ask — gating the sweep on the
    // answer's `gone` left that pane holding a dead session for good.
    expect(app).not.toContain("if (gone.length) panes.forgetMissing");
    // The sweep forgets only confirmed-gone sessions, and never one this tab holds (a stale
    // verdict must not clear a pane showing a session the client has).
    expect(app).toContain("panes.forgetMissing((id) => !!store.sessions[id] || !unknown.isGone(id))");
  });

  test("sessions.svelte.ts classifies through isNowhere and returns the verdict", () => {
    expect(sessions).toContain("isNowhere(error)");
    expect(sessions).toMatch(/async restore\(ids: string\[\]\): Promise<string\[\]>/);
    // No hand-rolled status check beside the shared rule.
    expect(sessions).not.toMatch(/error\)\.\w*status/);
  });

  test("api.ts hands the caller the status it failed with", () => {
    expect(api).toContain("throw new HttpError(message, res.status)");
  });

  test("the store reports the server's verdicts into the same book (closing must not be re-opened)", () => {
    // `#drop` is where `session-gone` and this tab's own close land; asking openHistory about a
    // closed session RE-OPENS it (the row is kept), so it must be a verdict, not a question.
    expect(sessions).toContain("unknown.confirmGone(id)");
    // ...and a session seen again revokes a stale verdict (ids can come back).
    expect(sessions).toContain("unknown.resurrect(");
  });

  test("a pane that names a session it has not loaded is not a new chat (the composer must not make it one)", () => {
    const pane = readFileSync(join(import.meta.dir, "..", "web", "src", "lib", "components", "ChatPane.svelte"), "utf8");
    // Sending in such a pane would create a session and replace the one in the shared workspace:
    // the E52 bug through the composer.
    expect(pane).toMatch(/if \(!current && pane\.sessionId\)/);
    // And the pane says what it is doing instead of offering a new chat.
    expect(pane).toContain("Opening this session…");
  });
});
