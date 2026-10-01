/**
 * The status dot of a pane, as the sidebar's window rows show it: a pure rule, tested apart from
 * the stores.
 *
 * - `live`: the pane's session is running.
 * - `done`: a turn this pane saw running has finished (`done`, or `error`), and the pane has not been
 *   clicked since. The first click turns it `idle`.
 * - `idle`: everything else: a new chat, a session that is waiting, an interrupted turn (that was your
 *   own doing), or a finished turn already looked at.
 *
 * The server only knows a session's status, not whether you have seen it, so each pane keeps two
 * turn ids (a turn is told apart by `startedAt`, which the server resets for every prompt):
 * `liveTurn`, the last turn seen running in this pane, and `seenTurn`, the last one acknowledged.
 */
export type PaneStatus = "live" | "done" | "idle";

export interface PaneTurns {
  liveTurn: number | null;
  seenTurn: number | null;
}

export interface SessionTurn {
  status: string;
  startedAt: number;
}

export function paneStatus(session: SessionTurn | null | undefined, pane: PaneTurns): PaneStatus {
  if (!session) return "idle";
  if (session.status === "running") return "live";
  const finished = session.status === "done" || session.status === "error";
  if (finished && pane.liveTurn !== null && session.startedAt === pane.liveTurn && pane.seenTurn !== pane.liveTurn) return "done";
  return "idle";
}

/** A pane's dot in words: what the sidebar's tooltip and the screen reader say. */
export function statusLabel(status: PaneStatus, error = false): string {
  return status === "live" ? "working" : status === "done" ? (error ? "finished with an error" : "done") : "idle";
}
