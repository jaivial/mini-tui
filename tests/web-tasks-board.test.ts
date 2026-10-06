/** The task board's rows and words: order, where each session lives, the hover glance. */
import { describe, expect, test } from "bun:test";
import { boardRows, previewLines, todoCounts, whereLabel } from "../web/src/lib/tasks";
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

describe("todoCounts and the hover glance", () => {
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

  test("the glance names the session and how its to-dos stand", () => {
    const rows = boardRows([task], () => "Alpha", () => null);
    expect(previewLines(rows)).toEqual([{ title: "Alpha", detail: "Fix login — 2 done, 1 pending, 3 left" }]);
  });

  test("the glance is short: only the first few rows", () => {
    const rows = boardRows(Array.from({ length: 9 }, (_, i) => card(`s-${i}`, i, `task ${i}`)), (id) => `title ${id}`, () => null);
    expect(previewLines(rows)).toHaveLength(5);
    expect(previewLines(rows, 2)).toHaveLength(2);
  });
});
