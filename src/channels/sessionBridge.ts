/**
 * Thread→session routing: one bound thread maps to one stable mini session
 * (the binding's accepted `session` id). The first message creates the session;
 * every later message continues the same conversation. The reply is whatever the
 * session's own agent produced — routing never answers on the agent's behalf.
 *
 * Turn state is durable per accepted message (`channel_turns`), so a restart
 * mid-flow re-joins the running turn instead of prompting the agent twice, and a
 * completed turn is never repeated.
 */
import type { Database } from "bun:sqlite";
import type { Inbound } from "./inbox";

/** The slice of the live session the bridge needs (kept fresh by the session manager). */
export interface LiveSessionLike {
  id: string;
  status: string;
  events: ReadonlyArray<{ type: string; text?: string }>;
}

export interface SessionBridgeConfig {
  /** Folder the channel sessions work in. Must exist and be writable. */
  cwd: string;
  /** Optional model override; empty means the operator's saved default. */
  model?: string;
  /** Give up waiting for the agent after this long (default 3 min). */
  turnTimeoutMs?: number;
  /** Sent (quoted) when the turn itself fails, so the thread is never left hanging. */
  errorNotice: string;
  /** Sent when the accepted message carries no text (media is WA-4's scope). */
  attachmentNotice: string;
}

export interface SessionBridgeDeps {
  /** The session with this exact id, resumed from history when the server forgot it. */
  get(id: string): Promise<LiveSessionLike | undefined>;
  /** Create a NEW session with this exact id; its first turn is `prompt`. */
  create(init: { id: string; prompt: string; cwd: string; model?: string }): Promise<void>;
  /** Continue an existing session's conversation with `prompt`. */
  send(id: string, prompt: string): Promise<void>;
  /** Bounded context for operations; never message content. */
  log?(message: string): void;
}

/** One accepted inbox row (the immutable accepted route, not a re-resolved binding). */
export interface DeliveryRow {
  seq: number;
  session: string;
  project: string;
  payload: string;
}

interface TurnRow {
  inbox_seq: number;
  session: string;
  status: string;
  reply: string | null;
  updated_at: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class SessionBridge {
  readonly db: Database;
  readonly #config: SessionBridgeConfig;
  readonly #deps: SessionBridgeDeps;
  readonly #timeoutMs: number;

  constructor(db: Database, config: SessionBridgeConfig, deps: SessionBridgeDeps) {
    if (!config.cwd) throw new Error("channel sessions need a working folder");
    if (!config.errorNotice || !config.attachmentNotice) throw new Error("channel notices must be configured");
    this.db = db;
    this.#config = config;
    this.#deps = deps;
    this.#timeoutMs = Math.min(Math.max(config.turnTimeoutMs ?? 180_000, 5_000), 600_000);
    db.exec(`CREATE TABLE IF NOT EXISTS channel_turns(
      inbox_seq INTEGER PRIMARY KEY,
      session TEXT NOT NULL,
      status TEXT NOT NULL,
      reply TEXT,
      updated_at INTEGER NOT NULL);`);
  }

  /**
   * Run the accepted message's turn and return the reply text to send (possibly
   * ""). Deterministic per row: a completed turn returns its recorded reply, a
   * running turn is waited on, never restarted.
   */
  async deliver(row: DeliveryRow): Promise<string> {
    const existing = this.db.query("SELECT inbox_seq,session,status,reply,updated_at FROM channel_turns WHERE inbox_seq=?1").get(row.seq) as TurnRow | undefined;
    if (existing) {
      if (existing.status !== "running") return existing.reply ?? "";
      // A previous attempt started this turn and died mid-wait: the prompt is
      // already in the conversation. Re-joining it is the only move that can
      // neither lose the message nor double-prompt the agent.
      if (Date.now() - existing.updated_at < 2 * this.#timeoutMs) return this.#awaitReply(row.session, existing);
    }
    const inbound = JSON.parse(row.payload) as Inbound;
    const text = inbound.text.trim();
    if (!text) {
      // Attachments-only: media handling is WA-4's scope. Say so honestly.
      return this.#finish(row, this.#config.attachmentNotice);
    }
    const prior = await this.#deps.get(row.session);
    try {
      if (prior) await this.#deps.send(row.session, text);
      else await this.#deps.create({ id: row.session, prompt: text, cwd: this.#config.cwd, model: this.#config.model });
    } catch (error) {
      const shape = error instanceof Error ? error.message : "unknown error";
      this.#deps.log?.(`turn for seq ${row.seq} could not start: ${shape}`);
      return this.#finish(row, this.#config.errorNotice);
    }
    const running: TurnRow = { inbox_seq: row.seq, session: row.session, status: "running", reply: null, updated_at: Date.now() };
    this.db.query(`INSERT INTO channel_turns(inbox_seq,session,status,reply,updated_at) VALUES(?1,?2,'running',NULL,?3)
      ON CONFLICT(inbox_seq) DO UPDATE SET status='running', reply=NULL, updated_at=excluded.updated_at`).run(row.seq, row.session, running.updated_at);
    try {
      const reply = await this.#awaitReply(row.session, running);
      return this.#finish(row, reply);
    } catch (error) {
      const shape = error instanceof Error ? error.message : "unknown error";
      this.#deps.log?.(`turn for seq ${row.seq} failed: ${shape}`);
      return this.#finish(row, this.#config.errorNotice);
    }
  }

  /** Poll the live session until its turn ends, then take the agent's last answer. */
  async #awaitReply(id: string, started: TurnRow): Promise<string> {
    const deadline = started.updated_at + 2 * this.#timeoutMs;
    for (;;) {
      await sleep(500);
      const session = await this.#deps.get(id);
      if (!session) throw new Error("the channel session disappeared mid-turn");
      if (session.status !== "running") {
        for (let i = session.events.length - 1; i >= 0; i--) {
          const event = session.events[i];
          if (event.type === "assistant" && typeof event.text === "string" && event.text.trim()) return event.text.trim();
        }
        if (session.status === "done") return ""; // finished without a visible text answer
        throw new Error(`the session turn ended with status ${session.status}`);
      }
      if (Date.now() > deadline) throw new Error("the session turn timed out");
    }
  }

  #finish(row: DeliveryRow, reply: string): string {
    this.db.query(`INSERT INTO channel_turns(inbox_seq,session,status,reply,updated_at) VALUES(?1,?2,'complete',?3,?4)
      ON CONFLICT(inbox_seq) DO UPDATE SET status='complete', reply=excluded.reply, updated_at=excluded.updated_at`).run(row.seq, row.session, reply, Date.now());
    return reply;
  }
}
