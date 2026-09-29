/**
 * When to say "this session finished": a pure rule, so it can be tested apart from the stores.
 *
 * Status reaches the app on two channels (the shared stream and each session's socket), in either
 * order, sometimes twice. A finish is announced once per turn: the first time a session seen
 * `running` is seen stopped. A session never seen running here (loaded already finished, restored from
 * history) is never announced, so opening the app does not replay a toast for every old session.
 * A turn is told apart by `startedAt`, which the server resets for every new prompt.
 */
export type Status = "idle" | "running" | "done" | "error" | "interrupted";

export interface Finish {
  id: string;
  status: Exclude<Status, "running" | "idle">;
}

export class FinishWatcher {
  /** Session id -> startedAt of the turn seen running and not announced yet. */
  #running = new Map<string, number>();
  /** Session id -> startedAt of the last turn announced (a late duplicate frame must not repeat it). */
  #announced = new Map<string, number>();

  /** Feed every status seen for a session; returns a finish to announce, at most once per turn. */
  observe(id: string, status: Status, startedAt: number): Finish | null {
    if (status === "running") {
      if (this.#announced.get(id) !== startedAt) this.#running.set(id, startedAt);
      return null;
    }
    const turn = this.#running.get(id);
    if (turn === undefined) return null;
    this.#running.delete(id);
    if (status === "idle") return null;
    this.#announced.set(id, turn);
    return { id, status };
  }

  forget(id: string) {
    this.#running.delete(id);
    this.#announced.delete(id);
  }
}

/** Title and tone for the toast. An interrupt was the user's own doing: it is not announced. */
export function finishMessage(status: Finish["status"], title: string, exitStatus = ""): { title: string; detail: string; tone: "ok" | "err" } | null {
  const name = title.trim() || "Untitled";
  if (status === "interrupted") return null;
  if (status === "done") return { title: "Session finished", detail: name, tone: "ok" };
  return { title: "Session stopped with an error", detail: exitStatus && exitStatus !== "error" ? `${name} · ${exitStatus}` : name, tone: "err" };
}
