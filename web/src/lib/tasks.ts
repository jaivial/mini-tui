/**
 * The tasks the app shows, apart from any UI: the board's rows (which sessions the drawer lists, in
 * what order, and where each one lives on screen) and each window's own task summary (its panes, the
 * general task its popover is titled with, and what each pane is doing). Pure functions, so the
 * ordering, the grouping and the words are testable without a browser (see tests/web-tasks-board.test.ts).
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

/**
 * One window's tasks, as the sidebar's popover shows them: the window's general task as the title and
 * a row per pane, each holding that pane's session and card. A pure shape so the grouping is testable
 * without a browser (see tests/web-tasks-board.test.ts).
 */
export interface PaneTasks {
  /** 1-based position in the window's reading order: what the pane is called on screen. */
  pane: number;
  /** The session's title, or "New chat" for a pane with none yet. */
  sessionTitle: string;
  /** That session's card, when it has one. */
  task: SessionTask | null;
  /** The card's to-dos, or nothing at all when the pane has no card. */
  counts: { done: number; pending: number; left: number } | null;
}

export interface WindowTasks {
  /** What you called the window: "Work", "Window 3". */
  window: string;
  /**
   * The general task of the window: the card of its first pane that has one, in reading order. It is
   * the popover's title — the one line that says what this whole window is for.
   */
  title: string;
  /** One row per pane, in reading order, whatever each pane's session is doing. */
  panes: PaneTasks[];
  /** How many panes hold a session with a card. */
  withTask: number;
}

const EMPTY_COUNTS = { done: 0, pending: 0, left: 0 };

/**
 * One window's rows: the general task (the first pane with a card speaks for the window) and one row
 * per pane. Panes with no session, or a session with no card, are still rows: they say so rather than
 * vanishing, because the row is the pane and the pane is on screen.
 */
export function windowTasks(
  windowLabel: string,
  panes: { sessionId: string | null; sessionTitle: string; task: SessionTask | null }[],
): WindowTasks {
  const rows = panes.map((pane, i) => ({
    pane: i + 1,
    sessionTitle: pane.sessionTitle,
    task: pane.task,
    counts: pane.task ? todoCounts(pane.task) : null,
  }));
  const first = rows.find((r) => r.task?.title)?.task ?? null;
  const withTask = rows.filter((r) => r.task).length;
  return {
    window: windowLabel,
    title: first?.title || (rows.length ? rows[0]!.sessionTitle : windowLabel),
    panes: rows,
    withTask,
  };
}

/** The one line a pane's nested popover leads with: what it is doing and how far along it is. */
export function paneSummary(pane: PaneTasks): string {
  if (!pane.task) return "No task card yet";
  const c = pane.counts ?? EMPTY_COUNTS;
  return `${pane.task.title} — ${c.done} done, ${c.pending} pending, ${c.left} left`;
}

/** The row label inside the popover: the pane's general task, with its number. */
export function paneRowLabel(pane: PaneTasks): string {
  return pane.task?.title || pane.sessionTitle;
}
