/**
 * The task board's rows and words, apart from any UI: which sessions the panel lists and in what
 * order, where each one lives on screen (the pane showing it), and the quick glance the window's
 * button shows on hover. Pure functions, so the ordering and the labels are testable without a
 * browser (see tests/web-tasks-board.test.ts).
 */
import type { SessionTask } from "./types";

/** Where a session is shown right now: which pane (its number) and the window that pane is in. */
export interface TaskWhere {
  pane: number;
  window: string;
}

export interface TaskRow {
  task: SessionTask;
  /** The session's title as the sidebar knows it (the card's own title is the *task's* title). */
  sessionTitle: string;
  /** Where the session is on screen, or null when no pane shows it. */
  where: TaskWhere | null;
}

/** How a card's to-dos stand, one count per bucket. */
export function todoCounts(task: SessionTask): { done: number; pending: number; left: number } {
  return { done: task.todos.done.length, pending: task.todos.pending.length, left: task.todos.left.length };
}

/**
 * The board's rows: sessions a pane is showing first (their cards are the live work), then the rest
 * by last update. A pane changing its session changes this order, never the cards themselves.
 */
export function boardRows(
  cards: SessionTask[],
  sessionTitle: (id: string) => string,
  where: (id: string) => TaskWhere | null,
): TaskRow[] {
  const rows = cards.map((task) => ({ task, sessionTitle: sessionTitle(task.id) || task.title, where: where(task.id) }));
  return rows.sort((a, b) => {
    const open = Number(b.where !== null) - Number(a.where !== null);
    return open || b.task.updatedAt - a.task.updatedAt;
  });
}

/** "Pane 2 · Work" for a session on screen, "Not open in a pane" for one that is not. */
export function whereLabel(where: TaskWhere | null): string {
  return where ? `Pane ${where.pane} · ${where.window}` : "Not open in a pane";
}

/** One line of the hover glance per row: session, task, and how its to-dos stand. */
export function previewLines(rows: TaskRow[], max = 5): { title: string; detail: string }[] {
  return rows.slice(0, max).map((row) => {
    const c = todoCounts(row.task);
    return {
      title: row.sessionTitle || row.task.title,
      detail: `${row.task.title} — ${c.done} done, ${c.pending} pending, ${c.left} left`,
    };
  });
}
