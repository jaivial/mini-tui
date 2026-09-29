/** "Session finished" toasts: once per turn, never for sessions that were already finished. */
import { describe, expect, test } from "bun:test";
import { FinishWatcher, finishMessage } from "../web/src/lib/finish";

describe("FinishWatcher", () => {
  test("running then done is announced once, however many frames repeat it", () => {
    const w = new FinishWatcher();
    expect(w.observe("s", "running", 1)).toBeNull();
    expect(w.observe("s", "running", 1)).toBeNull();
    expect(w.observe("s", "done", 1)).toEqual({ id: "s", status: "done" });
    expect(w.observe("s", "done", 1)).toBeNull(); // the other channel reporting the same finish
    expect(w.observe("s", "running", 1)).toBeNull(); // a late, stale running frame of the same turn
    expect(w.observe("s", "done", 1)).toBeNull();
  });
  test("a session loaded already finished is never announced", () => {
    const w = new FinishWatcher();
    expect(w.observe("old", "done", 5)).toBeNull();
    expect(w.observe("old", "error", 5)).toBeNull();
  });
  test("each new turn (a new startedAt) is announced again", () => {
    const w = new FinishWatcher();
    w.observe("s", "running", 1);
    expect(w.observe("s", "done", 1)).not.toBeNull();
    w.observe("s", "running", 2);
    expect(w.observe("s", "error", 2)).toEqual({ id: "s", status: "error" });
  });
  test("an interrupt ends the turn; idle is not a finish", () => {
    const w = new FinishWatcher();
    w.observe("s", "running", 1);
    expect(w.observe("s", "interrupted", 1)).toEqual({ id: "s", status: "interrupted" });
    w.observe("t", "running", 1);
    expect(w.observe("t", "idle", 1)).toBeNull();
  });
  test("sessions are independent", () => {
    const w = new FinishWatcher();
    w.observe("a", "running", 1);
    w.observe("b", "running", 1);
    expect(w.observe("b", "done", 1)?.id).toBe("b");
    expect(w.observe("a", "done", 1)?.id).toBe("a");
  });
});

describe("finishMessage", () => {
  test("done and error have words and a tone; an interrupt you asked for is not announced", () => {
    expect(finishMessage("done", "Fix the retry")).toEqual({ title: "Session finished", detail: "Fix the retry", tone: "ok" });
    expect(finishMessage("error", "Fix the retry", "LimitsExceeded")).toEqual({ title: "Session stopped with an error", detail: "Fix the retry · LimitsExceeded", tone: "err" });
    expect(finishMessage("error", "  ")?.detail).toBe("Untitled");
    expect(finishMessage("interrupted", "x")).toBeNull();
  });
});
