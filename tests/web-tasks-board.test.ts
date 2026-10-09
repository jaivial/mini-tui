/** The task board's rows and words: order, where each session lives, and each window's own summary. */
import { describe, expect, test } from "bun:test";
import { boardRows, paneRowLabel, paneSummary, todoCounts, whereLabel, windowTasks } from "../web/src/lib/tasks";
import type { SessionTask } from "../web/src/lib/types";

const card = (id: string, updatedAt: number, title = `task of ${id}`): SessionTask => ({
  id,
  title,
  description: "",
  todos: { done: [], pending: [], left: [] },
  updatedAt,
});

describe("boardRows", () => {
  const titles: Record<string, string> = { "s-1": "Alpha", "s-2": "Beta", "s-3": "Gamma" };
  const title = (id: string) => titles[id] ?? "";

  test("sessions a pane shows come first; the rest follow by last update", () => {
    const rows = boardRows([card("s-1", 300), card("s-2", 100), card("s-3", 200)], title, (id) => (id === "s-2" ? { pane: 2, window: "Work" } : null));
    expect(rows.map((r) => r.task.id)).toEqual(["s-2", "s-1", "s-3"]); // open first, then newest update
  });

  test("a row knows its session's title and where it lives", () => {
    const [row] = boardRows([card("s-1", 1)], title, () => ({ pane: 1, window: "Work" }));
    expect(row).toMatchObject({ sessionTitle: "Alpha", where: { pane: 1, window: "Work" } });
  });

  test("a card whose session is not open falls back to the card's own title", () => {
    const [row] = boardRows([card("s-unknown", 1, "Fix login")], title, () => null);
    expect(row.sessionTitle).toBe("Fix login");
  });

  test("the board is untouched: a pane changing session only changes the order", () => {
    const cards = [card("s-1", 300), card("s-2", 100)];
    const before = boardRows(cards, title, () => null).map((r) => r.task.id);
    const after = boardRows(cards, title, (id) => (id === "s-2" ? { pane: 1, window: "" } : null)).map((r) => r.task.id);
    expect(before).toEqual(["s-1", "s-2"]);
    expect(after).toEqual(["s-2", "s-1"]);
  });
});

describe("whereLabel", () => {
  test("a session on screen names its pane and the window holding it", () => {
    expect(whereLabel({ pane: 2, window: "Work" })).toBe("Pane 2 · Work");
    expect(whereLabel({ pane: 1, window: "Window 3" })).toBe("Pane 1 · Window 3");
  });
  test("one that no pane shows says exactly that", () => {
    expect(whereLabel(null)).toBe("Not open in a pane");
  });
});

describe("todoCounts", () => {
  const task: SessionTask = {
    id: "s-1",
    title: "Fix login",
    description: "",
    todos: { done: ["a", "b"], pending: ["c"], left: ["d", "e", "f"] },
    updatedAt: 1,
  };

  test("one count per bucket", () => {
    expect(todoCounts(task)).toEqual({ done: 2, pending: 1, left: 3 });
  });
});

describe("windowTasks", () => {
  const alpha: SessionTask = {
    id: "s-alpha",
    title: "Fix the login bug",
    description: "Reworked auth.",
    todos: { done: ["parse tokens"], pending: [], left: ["write tests"] },
    updatedAt: 2,
  };
  const beta: SessionTask = {
    id: "s-beta",
    title: "Write the docs",
    description: "",
    todos: { done: ["intro"], pending: ["api"], left: [] },
    updatedAt: 1,
  };

  test("one row per pane, in reading order, numbered from one", () => {
    const t = windowTasks("Work", [
      { sessionId: "s-alpha", sessionTitle: "Alpha", task: alpha },
      { sessionId: "s-beta", sessionTitle: "Beta", task: beta },
    ]);
    expect(t.panes.map((p) => p.pane)).toEqual([1, 2]);
    expect(t.panes.map((p) => p.task?.title)).toEqual(["Fix the login bug", "Write the docs"]);
    expect(t.withTask).toBe(2);
  });

  test("the title is the general task: the first pane that has one speaks for the window", () => {
    const t = windowTasks("Work", [
      { sessionId: null, sessionTitle: "New chat", task: null },
      { sessionId: "s-alpha", sessionTitle: "Alpha", task: alpha },
    ]);
    expect(t.title).toBe("Fix the login bug");
  });

  test("a window whose panes have no card falls back to the first pane's session title", () => {
    const t = windowTasks("Window 2", [{ sessionId: "s-x", sessionTitle: "Scratch", task: null }]);
    expect(t.title).toBe("Scratch");
    expect(t.withTask).toBe(0);
  });

  test("a pane with no session is still a row, and says so", () => {
    const t = windowTasks("Work", [{ sessionId: null, sessionTitle: "New chat", task: null }]);
    expect(t.panes).toHaveLength(1);
    expect(t.panes[0]!.counts).toBeNull();
    expect(paneRowLabel(t.panes[0]!)).toBe("New chat");
    expect(paneSummary(t.panes[0]!)).toBe("No task card yet");
  });

  test("a pane's summary says what it is doing and how far along it is", () => {
    const t = windowTasks("Work", [{ sessionId: "s-alpha", sessionTitle: "Alpha", task: alpha }]);
    expect(paneRowLabel(t.panes[0]!)).toBe("Fix the login bug");
    expect(paneSummary(t.panes[0]!)).toBe("Fix the login bug \u2014 1 done, 0 pending, 1 left");
  });
});
