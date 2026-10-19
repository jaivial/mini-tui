/**
 * The sessions a pane shows that this client has not loaded (E52).
 *
 * The workspace (which pane shows what) is shared by every tab, window and device, but the session
 * LIST each client holds is its own: a tab only knows the sessions that were live at its boot, the
 * ones it restored, and the ones the metadata stream announced. Another tab can open a saved session
 * from the Resume panel and show it in a pane; here that session simply is not in the list yet.
 * **"Not in my list" is not "it is gone"** — only the server can say that, and it already follows
 * this exact rule (`held()` in src/web/serve.ts): 404 for an id that is nowhere, 503 for anything
 * else that stopped it reading, because "answering 404 made the browser conclude the session was
 * deleted and turn its pane into a new chat".
 *
 * E52: an idle tab read "not in my list" as "deleted", cleared the pane and WROTE that into the
 * shared workspace ~20 ms later, so the tab that clicked saw its own click undone (the reported
 * "clicking a session in the sidebar does not change the pane"). The two answers are different
 * things and this bookkeeping keeps them apart: an unknown session is ASKED about, and only a
 * verdict from the server forgets it.
 *
 * A verdict comes two ways, and both are the server speaking: an answer of 404 (`isNowhere`) or its
 * own announcement that the session is gone (`confirmGone`: `session-gone`, or this tab closing it —
 * closing KEEPS the saved row, so asking `openHistory` about it would RE-OPEN what the user just
 * closed). A verdict is revoked the moment the session is seen again (`resurrect`): ids can come
 * back (`upsertSubagentSession` re-creates a subagent's row), and a stale verdict must never clear
 * a pane that shows a session this client holds.
 */
export class UnknownSessions {
  /** Ids with a question in flight, and when it was asked: the same id is not asked twice at once. */
  #flight = new Map<string, number>();
  /** Ids the server said it does not hold: never asked again; their panes are new chats. */
  #gone = new Set<string>();

  /**
   * The shown ids this client cannot vouch for and is not already asking about. A question older
   * than `flightMs` counts as lost (a fetch that will never settle must not silence an id for good).
   */
  pick(ids: Iterable<string>, known: (id: string) => boolean, now = Date.now(), flightMs = FLIGHT_MS): string[] {
    const out: string[] = [];
    for (const id of new Set(ids)) {
      const asked = this.#flight.get(id);
      if (known(id) || this.#gone.has(id) || (asked !== undefined && now - asked < flightMs)) continue;
      this.#flight.set(id, now);
      out.push(id);
    }
    return out;
  }

  /**
   * The answer to `asked`. Only `gone` is a verdict — the server's own "it does not hold this
   * session" (see `isNowhere`). Any other outcome (a network error, a busy server) proves nothing:
   * the id is free to be asked again later, and its pane keeps showing what it shows.
   */
  answer(asked: Iterable<string>, gone: Iterable<string> = []): void {
    for (const id of asked) this.#flight.delete(id);
    for (const id of gone) {
      this.#gone.add(id);
      this.#flight.delete(id);
    }
  }

  /** The server itself announced the session is gone (`session-gone`, or this tab closed it). */
  confirmGone(id: string): void {
    this.answer([id], [id]);
  }

  /** The session is here again (loaded, restored or announced): a stale verdict is revoked. */
  resurrect(id: string): void {
    this.#gone.delete(id);
  }

  /** The server said this session does not exist: its pane may become a new chat. */
  isGone(id: string): boolean {
    return this.#gone.has(id);
  }

  /** A question is in flight for this id. */
  asking(id: string): boolean {
    return this.#flight.has(id);
  }
}

/** How long a question may stay in flight before the id becomes askable again. */
export const FLIGHT_MS = 30_000;

/**
 * The only error that forgets a session: the server's own "it does not hold it" (HTTP 404). A
 * failure to ASK (the network, a busy server answering 503) is not an answer, and never clears a
 * pane — the same distinction the server makes in `held()`.
 */
export function isNowhere(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404;
}

/** The one book the app reads and writes: the store reports what the server announces, App asks. */
export const unknown = new UnknownSessions();
