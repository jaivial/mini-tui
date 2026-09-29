/**
 * The client end of a web terminal, on the tab's one hub socket (the same socket as notes). No REST,
 * no polling: output is pushed as the shell prints it, keys go back as `term.input`. On reconnect the
 * terminal is opened again, which re-attaches to the same shell and replays what it printed meanwhile.
 * Plain TypeScript (testable without a browser); the component draws it with xterm.js.
 */
import type { HubConnection } from "./hub";

export interface TermHandlers {
  opened(info: { cwd: string; title: string; replay: string; alive: boolean }): void;
  data(chunk: string): void;
  exit(code: number | null): void;
  error(message: string): void;
}

export class TermSession {
  #hub: HubConnection;
  #off: (() => void)[] = [];
  #size = { cols: 80, rows: 24 };
  #open = false;

  constructor(
    hub: HubConnection,
    readonly id: string,
    readonly session: string | null,
    readonly h: TermHandlers,
  ) {
    this.#hub = hub;
    this.#off.push(
      hub.on((m) => {
        if (m.id !== id) return;
        if (m.t === "term.opened") this.h.opened(m as never);
        else if (m.t === "term.data") this.h.data(String(m.data));
        else if (m.t === "term.exit") this.h.exit((m.code as number | null) ?? null);
        else if (m.t === "error") this.h.error(String(m.error));
      }),
      // A dropped socket: reopen on reconnect (the server re-attaches and replays).
      hub.onConnect(() => {
        if (this.#open) hub.send({ t: "term.open", id, session: session ?? undefined, ...this.#size });
      }),
    );
  }

  open(cols: number, rows: number) {
    this.#size = { cols, rows };
    this.#open = true;
    this.#hub.send({ t: "term.open", id: this.id, session: this.session ?? undefined, cols, rows });
  }
  input(data: string) {
    if (this.#open) this.#hub.send({ t: "term.input", id: this.id, data });
  }
  resize(cols: number, rows: number) {
    if (cols === this.#size.cols && rows === this.#size.rows) return;
    this.#size = { cols, rows };
    if (this.#open) this.#hub.send({ t: "term.resize", id: this.id, cols, rows });
  }
  /** Stop watching; the shell keeps running so the panel (or a reload) can come back to it. */
  detach() {
    if (this.#open) this.#hub.send({ t: "term.detach", id: this.id });
    this.#open = false;
    for (const off of this.#off) off();
    this.#off = [];
  }
  /** End the shell. */
  close() {
    this.#hub.send({ t: "term.close", id: this.id });
    this.#open = false;
    for (const off of this.#off) off();
    this.#off = [];
  }
}

/** One terminal per pane and session: the same pane coming back to the same session finds its shell. */
export const termIdFor = (paneId: string, sessionId: string | null) => `${paneId}.${sessionId ?? "new"}`.replace(/[^\w.-]/g, "_").slice(0, 128);
