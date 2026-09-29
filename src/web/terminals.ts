/**
 * Interactive terminals for the web app's right sidebar: a real PTY per terminal (Bun's built-in
 * `terminal` spawn option), streamed through the socket hub. Nothing here knows about sockets: a
 * viewer is a `send` function, so the rules are testable without a network.
 *
 * - A terminal outlives its viewers for a while: close the tab, come back within `idleMs` and the same
 *   shell is there, with its recent output replayed. After that, or on `close`, the process is killed.
 * - Several viewers may watch one terminal (two tabs): they all see the output and can all type.
 * - Output is coalesced (one message per `flushMs`) and a flood is cut to its tail with a marker, so
 *   `yes` cannot pin the server or the browser.
 * - A local terminal starts in the session's folder; a remote one is `ssh -tt` to the host, in its folder.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";

export interface TermViewer {
  send(msg: TermOut): boolean;
}

export type TermOut =
  | { t: "term.opened"; id: string; cwd: string; title: string; replay: string; alive: boolean }
  | { t: "term.data"; id: string; data: string }
  | { t: "term.exit"; id: string; code: number | null }
  | { t: "error"; id?: string; error: string };

export interface OpenSpec {
  cols: number;
  rows: number;
  /** Local folder to start in (ignored for remote). */
  cwd?: string;
  /** A remote host: the terminal is an ssh session there. */
  remote?: { args: string[]; workdir: string; label: string };
}

interface Term {
  id: string;
  proc: ReturnType<typeof Bun.spawn>;
  pty: { write(d: string): void; resize(c: number, r: number): void; close(): void };
  viewers: Set<TermViewer>;
  /** Recent output, replayed to a viewer that (re)attaches. */
  backlog: string;
  pending: string;
  timer?: ReturnType<typeof setTimeout>;
  idle?: ReturnType<typeof setTimeout>;
  alive: boolean;
  code: number | null;
  cwd: string;
  title: string;
}

export const TERM_ID = /^[\w.-]{1,128}$/;

export class Terminals {
  #terms = new Map<string, Term>();
  readonly max: number;
  readonly backlogMax: number;
  readonly flushMs: number;
  readonly idleMs: number;
  readonly floodMax: number;
  readonly enabled: boolean;

  constructor(o: { max?: number; backlogMax?: number; flushMs?: number; idleMs?: number; floodMax?: number; enabled?: boolean } = {}) {
    this.max = o.max ?? 12;
    this.backlogMax = o.backlogMax ?? 200_000;
    this.flushMs = o.flushMs ?? 16;
    this.idleMs = o.idleMs ?? 10 * 60_000;
    this.floodMax = o.floodMax ?? 1_000_000;
    this.enabled = o.enabled ?? process.env.MINITUI_WEB_TERMINAL !== "0";
  }

  get size(): number {
    return this.#terms.size;
  }
  has(id: string): boolean {
    return this.#terms.has(id);
  }

  /** Attach `viewer` to terminal `id`, starting it if it is not running. */
  open(viewer: TermViewer, id: string, spec: OpenSpec): void {
    if (!this.enabled) return void viewer.send({ t: "error", id, error: "the web terminal is turned off on this server (MINITUI_WEB_TERMINAL=0)" });
    if (!TERM_ID.test(id)) return void viewer.send({ t: "error", id, error: "invalid terminal id" });
    let term = this.#terms.get(id);
    if (term && !term.alive) {
      // An exited shell is not reattached: a fresh one takes its place.
      this.#dispose(term);
      term = undefined;
    }
    if (!term) {
      if (this.#terms.size >= this.max) return void viewer.send({ t: "error", id, error: `at most ${this.max} terminals at once: close one first` });
      try {
        term = this.#start(id, spec);
      } catch (error) {
        return void viewer.send({ t: "error", id, error: `could not start a shell: ${(error as Error).message}` });
      }
    }
    if (term.idle) clearTimeout(term.idle);
    term.idle = undefined;
    term.viewers.add(viewer);
    this.resize(id, spec.cols, spec.rows);
    viewer.send({ t: "term.opened", id, cwd: term.cwd, title: term.title, replay: term.backlog, alive: term.alive });
  }

  input(id: string, data: string): void {
    const term = this.#terms.get(id);
    if (!term?.alive || typeof data !== "string" || data.length > 65_536) return;
    term.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const term = this.#terms.get(id);
    if (!term?.alive) return;
    const c = Math.max(2, Math.min(500, Math.floor(cols) || 80));
    const r = Math.max(1, Math.min(200, Math.floor(rows) || 24));
    try {
      term.pty.resize(c, r);
    } catch {
      /* the process is going away */
    }
  }

  /** Stop watching; the shell keeps running for `idleMs` so a reload finds it again. */
  detach(viewer: TermViewer, id?: string): void {
    for (const term of id ? [this.#terms.get(id)].filter(Boolean) as Term[] : this.#terms.values()) {
      if (!term.viewers.delete(viewer) || term.viewers.size) continue;
      term.idle = setTimeout(() => this.kill(term.id), this.idleMs);
    }
  }

  /** End a terminal now (its tab was closed, or its session deleted). */
  kill(id: string): void {
    const term = this.#terms.get(id);
    if (term) this.#dispose(term);
  }

  killAll(): void {
    for (const term of [...this.#terms.values()]) this.#dispose(term);
  }

  #start(id: string, spec: OpenSpec): Term {
    const decoder = new TextDecoder();
    let term!: Term;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(MSWEA_CONTROL_FILE|MINITUI_MINI_BIN|MINITUI_EMBEDDED_AGENT)$/.test(k)) env[k] = v;
    Object.assign(env, { TERM: "xterm-256color", COLORTERM: "truecolor", MINITUI_WEB_TERMINAL_ID: id });
    let cmd: string[];
    let cwd: string;
    let title: string;
    if (spec.remote) {
      const dir = spec.remote.workdir || "~";
      const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
      const into = dir === "~" ? 'cd "$HOME"' : dir.startsWith("~/") ? `cd "$HOME"/${q(dir.slice(2))}` : `cd ${q(dir)}`;
      cmd = ["ssh", "-tt", ...spec.remote.args, `${into} 2>/dev/null || cd "$HOME"; exec "\${SHELL:-/bin/bash}" -l`];
      cwd = homedir();
      title = `${spec.remote.label}:${dir}`;
    } else {
      const want = spec.cwd?.trim();
      cwd = want && existsSync(want) && statSync(want).isDirectory() ? want : homedir();
      cmd = [process.env.SHELL || "/bin/bash", "-l"];
      title = cwd;
    }
    const proc = Bun.spawn(cmd, {
      cwd,
      env,
      terminal: {
        cols: Math.max(2, Math.min(500, spec.cols || 80)),
        rows: Math.max(1, Math.min(200, spec.rows || 24)),
        data: (_t: unknown, chunk: Uint8Array) => this.#output(term, decoder.decode(chunk, { stream: true })),
      },
    } as never) as ReturnType<typeof Bun.spawn> & { terminal: Term["pty"] };
    term = { id, proc, pty: proc.terminal, viewers: new Set(), backlog: "", pending: "", alive: true, code: null, cwd, title };
    this.#terms.set(id, term);
    void proc.exited.then((code) => {
      term.alive = false;
      term.code = code;
      this.#flush(term);
      for (const v of term.viewers) v.send({ t: "term.exit", id, code });
      // Nobody watching: nothing to show the exit to, so forget it now.
      if (!term.viewers.size) this.#dispose(term);
    });
    return term;
  }

  #output(term: Term, data: string) {
    if (!data || !term) return;
    term.backlog = (term.backlog + data).slice(-this.backlogMax);
    term.pending += data;
    if (term.pending.length > this.floodMax) {
      term.pending = `\r\n\x1b[2m[output truncated: too much at once]\x1b[0m\r\n${term.pending.slice(-Math.floor(this.floodMax / 4))}`;
    }
    if (!term.timer) term.timer = setTimeout(() => this.#flush(term), this.flushMs);
  }

  #flush(term: Term) {
    if (term.timer) clearTimeout(term.timer);
    term.timer = undefined;
    if (!term.pending) return;
    const data = term.pending;
    term.pending = "";
    for (const v of term.viewers) v.send({ t: "term.data", id: term.id, data });
  }

  #dispose(term: Term) {
    if (term.timer) clearTimeout(term.timer);
    if (term.idle) clearTimeout(term.idle);
    this.#terms.delete(term.id);
    if (term.alive) {
      try {
        term.proc.kill("SIGHUP");
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          if (term.alive) term.proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 2000).unref?.();
    }
    try {
      term.pty.close();
    } catch {
      /* already closed */
    }
  }
}
