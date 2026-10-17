/**
 * The WhatsApp ↔ web mirror store (espejo).
 *
 * One durable row per WhatsApp message that the web transcript must show but
 * the agent's own journal never will: messages the consumer acks WITHOUT a
 * turn (a group message that did not ask for the bot, an operator chat
 * command). Turn-generating messages already reach the web through the
 * session's saved transcript, so mirroring them too would draw every one
 * twice; the consumer decides at the only place the decision is made.
 *
 * Anti-loop contract: a mirror row is DATA for a browser, never a prompt. The
 * web server reads rows and renders events; nothing in the read path can
 * start a turn, and rows written here never go back to WhatsApp. A relayed
 * web prompt is dropped on the WhatsApp side instead: its sent id is
 * registered as our own send (channel_own_sends) and the receiver refuses the
 * echo before it can ever become an inbox row — so a relay can never be
 * re-mirrored or turn the agent.
 */

import type { Database } from "bun:sqlite";
import { cleanSenderName } from "./senderName";

export interface MirrorAttachment {
  id: string;
  kind: "image" | "audio" | "document";
  mime: string | null;
  /** Absolute path in the media store when the bytes were fetched, else null. */
  path: string | null;
}

export interface MirrorAppend {
  inboxSeq: number;
  session: string;
  channel: string;
  account: string;
  thread: string;
  messageId: string;
  sender: string;
  /** Display only: the name the sender chose, when the delivery carried one. */
  senderName?: string;
  sentAt: number;
  text: string;
  attachments: MirrorAttachment[];
}

export interface MirrorRow {
  id: number;
  inboxSeq: number;
  session: string;
  channel: string;
  account: string;
  thread: string;
  messageId: string;
  sender: string;
  senderName: string | null;
  sentAt: number;
  text: string;
  attachments: MirrorAttachment[];
}

const MAX_MIRROR_TEXT = 64_000;
const MAX_ROWS = 10_000;

export class MirrorStore {
  readonly db: Database;
  constructor(db: Database) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS channel_mirror(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inbox_seq INTEGER NOT NULL,
      session TEXT NOT NULL,
      channel TEXT NOT NULL,
      account TEXT NOT NULL,
      thread TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      text TEXT NOT NULL,
      attachments TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      UNIQUE(channel, message_id))`);
    db.exec(`CREATE INDEX IF NOT EXISTS channel_mirror_session ON channel_mirror(session,id)`);
    // Additive column on stores written by an older build (CREATE TABLE IF NOT
    // EXISTS alone never widens an existing table), the same pattern
    // ChannelInbox uses for channel_bindings.
    const columns = (db.query("PRAGMA table_info(channel_mirror)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!columns.includes("sender_name")) db.exec(`ALTER TABLE channel_mirror ADD COLUMN sender_name TEXT`);
  }

  /** Idempotent per (channel, message_id): a replayed delivery or a second
   * process appending the same message lands once. Returns the row id, or
   * null when the row already existed. */
  append(row: MirrorAppend): number | null {
    if (!row.session || Buffer.byteLength(row.text) > MAX_MIRROR_TEXT || row.attachments.length > 16) return null;
    // Keep the store bounded: a mirror is a recent-conversation projection, not an archive.
    try {
      this.db.query(
        `DELETE FROM channel_mirror WHERE id <= (SELECT COALESCE(MAX(id),0) FROM channel_mirror) - ?1`,
      ).run(MAX_ROWS);
    } catch {
      // a busy database loses only the prune, never the append
    }
    const result = this.db
      .query(
        `INSERT OR IGNORE INTO channel_mirror(inbox_seq,session,channel,account,thread,message_id,sender,sender_name,sent_at,text,attachments,created_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
      )
      .run(row.inboxSeq, row.session, row.channel, row.account, row.thread, row.messageId, row.sender, cleanSenderName(row.senderName), row.sentAt, row.text, JSON.stringify(row.attachments), Date.now());
    if (Number(result.changes) === 0) return null; // already mirrored
    return Number(result.lastInsertRowid) || null;
  }

  after(after: number, limit = 200): MirrorRow[] {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) return [];
    const rows = this.db
      .query(`SELECT id,inbox_seq,session,channel,account,thread,message_id,sender,sender_name,sent_at,text,attachments FROM channel_mirror WHERE id>?1 ORDER BY id LIMIT ?2`)
      .all(after, limit) as Array<{ id: number; inbox_seq: number; session: string; channel: string; account: string; thread: string; message_id: string; sender: string; sender_name: string | null; sent_at: number; text: string; attachments: string }>;
    return rows.map(fromRow);
  }

  /** A session's mirror, oldest first, missing what `existing` already shows
   * (events saved into the session's own transcript carry their mirrorId). */
  forSession(session: string, existing: readonly unknown[] = [], limit = 200): MirrorRow[] {
    if (!session || session.length > 256) return [];
    const shown = new Set(
      existing
        .map((e) => (e as { mirrorId?: unknown } | null)?.mirrorId)
        .filter((id): id is number => typeof id === "number"),
    );
    const rows = this.db
      .query(`SELECT id,inbox_seq,session,channel,account,thread,message_id,sender,sender_name,sent_at,text,attachments FROM channel_mirror WHERE session=?1 ORDER BY id DESC LIMIT ?2`)
      .all(session, limit) as Array<{ id: number; inbox_seq: number; session: string; channel: string; account: string; thread: string; message_id: string; sender: string; sender_name: string | null; sent_at: number; text: string; attachments: string }>;
    return rows
      .reverse()
      .map(fromRow)
      .filter((row) => !shown.has(row.id));
  }

  lastId(): number {
    const row = this.db.query(`SELECT COALESCE(MAX(id),0) AS id FROM channel_mirror`).get() as { id: number };
    return Number(row.id) || 0;
  }
}

function fromRow(row: { id: number; inbox_seq: number; session: string; channel: string; account: string; thread: string; message_id: string; sender: string; sender_name: string | null; sent_at: number; text: string; attachments: string }): MirrorRow {
  let attachments: MirrorAttachment[] = [];
  try {
    const parsed = JSON.parse(row.attachments) as unknown;
    if (Array.isArray(parsed)) {
      attachments = parsed
        .filter((a): a is MirrorAttachment => !!a && typeof a === "object" && typeof (a as MirrorAttachment).id === "string")
        .slice(0, 16)
        .map((a) => ({ id: a.id, kind: a.kind === "image" || a.kind === "audio" ? a.kind : "document", mime: a.mime ?? null, path: a.path ?? null }));
    }
  } catch {
    // a malformed list renders as a plain text bubble, never a crash
  }
  return {
    id: row.id,
    inboxSeq: row.inbox_seq,
    session: row.session,
    channel: row.channel,
    account: row.account,
    thread: row.thread,
    messageId: row.message_id,
    sender: row.sender,
    // Read back through the same rule: a name that somehow got stored unusable
    // falls back to the jid here rather than reaching a reader as-is.
    senderName: cleanSenderName(row.sender_name),
    sentAt: row.sent_at,
    text: row.text,
    attachments,
  };
}

/** The wire event a mirror row becomes (src/traj/schema.ts `channel`).
 * `url` is how the browser fetches stored media; null means metadata only. */
export function mirrorEvent(row: MirrorRow, mediaUrl: (path: string) => string | null): {
  type: "channel";
  channel: string;
  origin: "whatsapp";
  sender: string;
  /** Display only. Absent when the delivery carried no usable name; the web
   * falls back to the jid exactly as it did before this field existed. */
  senderName?: string;
  text: string;
  ts: number;
  mirrorId: number;
  attachments: Array<{ id: string; kind: string; mime: string | null; url: string | null }>;
} {
  return {
    type: "channel",
    channel: row.channel,
    origin: "whatsapp",
    sender: row.sender,
    ...(row.senderName ? { senderName: row.senderName } : {}),
    text: row.text,
    ts: row.sentAt,
    mirrorId: row.id,
    attachments: row.attachments.map((a) => ({ id: a.id, kind: a.kind, mime: a.mime, url: a.path ? mediaUrl(a.path) : null })),
  };
}
