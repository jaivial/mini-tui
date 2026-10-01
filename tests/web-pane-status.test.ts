/** The pane status dot: live while running, done until the pane is clicked, idle otherwise. */
import { describe, expect, test } from "bun:test";
import { paneStatus, statusLabel } from "../web/src/lib/paneStatus";

const fresh = { liveTurn: null, seenTurn: null };

describe("paneStatus", () => {
  test("a new chat, or a session never seen running here, is idle", () => {
    expect(paneStatus(null, fresh)).toBe("idle");
    expect(paneStatus({ status: "done", startedAt: 5 }, fresh)).toBe("idle");
    expect(paneStatus({ status: "idle", startedAt: 5 }, fresh)).toBe("idle");
  });
  test("a running session is live", () => {
    expect(paneStatus({ status: "running", startedAt: 5 }, fresh)).toBe("live");
    expect(paneStatus({ status: "running", startedAt: 5 }, { liveTurn: 5, seenTurn: 5 })).toBe("live");
  });
  test("a turn seen running that finished is done until it is acknowledged", () => {
    const pane = { liveTurn: 5, seenTurn: null as number | null };
    expect(paneStatus({ status: "done", startedAt: 5 }, pane)).toBe("done");
    expect(paneStatus({ status: "error", startedAt: 5 }, pane)).toBe("done");
    pane.seenTurn = 5; // the first click
    expect(paneStatus({ status: "done", startedAt: 5 }, pane)).toBe("idle");
  });
  test("an earlier acknowledgement does not hide the next finished turn", () => {
    expect(paneStatus({ status: "done", startedAt: 9 }, { liveTurn: 9, seenTurn: 5 })).toBe("done");
  });
  test("an interrupt is your own doing: idle, not done", () => {
    expect(paneStatus({ status: "interrupted", startedAt: 5 }, { liveTurn: 5, seenTurn: null })).toBe("idle");
  });
  test("a turn that started somewhere else (another device, a restart) is not this pane's to announce", () => {
    expect(paneStatus({ status: "done", startedAt: 9 }, { liveTurn: 5, seenTurn: null })).toBe("idle");
  });
  test("labels", () => {
    expect([statusLabel("live"), statusLabel("done"), statusLabel("done", true), statusLabel("idle")]).toEqual(["working", "done", "finished with an error", "idle"]);
  });
});
