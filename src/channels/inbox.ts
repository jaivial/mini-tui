/** Transport-neutral inbox. Incoming text is data, never a grant to act as the user. */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Channel = "gmail" | "whatsapp" | "apple-messages";
export interface Attachment {
  id: string;
  kind: "image" | "audio" | "document";
  mime?: string;
  /** A provider reference only. Ingestion does not fetch an arbitrary external URL. */
  providerRef?: string;
  transcript?: string;
  transcriptionState?: "pending" | "complete" | "uncertain" | "failed";
}
export interface Inbound {
  channel: Channel;
  account: string;
  thread: string;
  messageId: string;
  sender: string;
  sentAt: number;
  text: string;
  replyTo?: string;
  attachments: Attachment[];
}
export interface Binding {
  channel: Channel;
  account: string;
  thread: string;
  session: string;
  project: string;
  /** Grounded operator configuration, not identity claimed by a webhook body. */
  allowedSenders: string[];
}
const bounded = (value: string, max = 256) => value.length > 0 && Buffer.byteLength(value) <= max && !/[\x00-\x1f]/.test(value);
function checkRoute(v: { channel: Channel; account: string; thread: string }) {
  if (!["gmail", "whatsapp", "apple-messages"].includes(v.channel) || !bounded(v.account) || !bounded(v.thread)) throw new Error("invalid channel route");
}

export class ChannelInbox {
  readonly db: Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS channel_bindings(channel TEXT,account TEXT,thread TEXT,session TEXT NOT NULL,project TEXT NOT NULL,allowed_senders TEXT NOT NULL,PRIMARY KEY(channel,account,thread));
      CREATE TABLE IF NOT EXISTS channel_updates(update_seq INTEGER PRIMARY KEY AUTOINCREMENT,inbox_seq INTEGER NOT NULL,attachment_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_consumers(consumer TEXT PRIMARY KEY,cursor INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS channel_inbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,channel TEXT NOT NULL,account TEXT NOT NULL,thread TEXT NOT NULL,message_id TEXT NOT NULL,sender TEXT NOT NULL,sent_at INTEGER NOT NULL,payload TEXT NOT NULL,session TEXT NOT NULL,project TEXT NOT NULL,received_at INTEGER NOT NULL,original TEXT NOT NULL,UNIQUE(channel,account,thread,message_id));`);
  }
  bind(binding: Binding): void {
    checkRoute(binding);
    if (!bounded(binding.session) || !bounded(binding.project) || !binding.allowedSenders.length || binding.allowedSenders.length > 100 || binding.allowedSenders.some(s => !bounded(s))) throw new Error("invalid binding");
    this.db.query(`INSERT INTO channel_bindings VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(channel,account,thread) DO UPDATE SET session=excluded.session,project=excluded.project,allowed_senders=excluded.allowed_senders`).run(binding.channel, binding.account, binding.thread, binding.session, binding.project, JSON.stringify(binding.allowedSenders));
  }
  accept(message: Inbound): { seq: number; duplicate: boolean; session: string; project: string } {
    checkRoute(message);
    if (!bounded(message.messageId) || !bounded(message.sender) || !Number.isSafeInteger(message.sentAt) || message.sentAt < 0 || Buffer.byteLength(message.text) > 64_000 || message.attachments.length > 16 || (message.replyTo && !bounded(message.replyTo))) throw new Error("invalid inbound message");
    for (const a of message.attachments) {
      if ((a.mime && !bounded(a.mime,128)) || (a.transcriptionState && !["pending","complete","uncertain","failed"].includes(a.transcriptionState))) throw new Error("invalid attachment metadata");
      if (!bounded(a.id) || !["image", "audio", "document"].includes(a.kind) || (a.providerRef && Buffer.byteLength(a.providerRef) > 2048) || (a.transcript && Buffer.byteLength(a.transcript) > 64_000)) throw new Error("invalid attachment");
    }
    const payload = JSON.stringify(message);
    if (Buffer.byteLength(payload) > 256_000) throw new Error("inbound payload exceeds cap");
    return this.db.transaction(() => {
      const binding = this.db.query(`SELECT session,project,allowed_senders FROM channel_bindings WHERE channel=?1 AND account=?2 AND thread=?3`).get(message.channel, message.account, message.thread) as { session: string; project: string; allowed_senders: string } | null;
      if (!binding || !(JSON.parse(binding.allowed_senders) as string[]).includes(message.sender)) throw new Error("unbound route or unapproved sender");
      const old = this.db.query(`SELECT seq,original,session,project FROM channel_inbox WHERE channel=?1 AND account=?2 AND thread=?3 AND message_id=?4`).get(message.channel,message.account,message.thread,message.messageId) as { seq: number; original: string; session: string; project: string } | null;
      if (old) {
        // sentAt is transport metadata (e.g. the fork's per-delivery envelope
        // time), not message content: a redelivered message arrives in a new
        // envelope. Compare every content field structurally; any difference
        // under the same id is reuse, never a duplicate.
        const previous = JSON.parse(old.original) as Inbound;
        const canonical = (attachments: Attachment[]) => JSON.stringify(attachments.map(a => ({ id: a.id, kind: a.kind, mime: a.mime ?? null, providerRef: a.providerRef ?? null, transcript: a.transcript ?? null, transcriptionState: a.transcriptionState ?? null })));
        const sameContent = previous.channel === message.channel && previous.account === message.account && previous.thread === message.thread && previous.messageId === message.messageId && previous.sender === message.sender && previous.text === message.text && (previous.replyTo ?? null) === (message.replyTo ?? null) && canonical(previous.attachments) === canonical(message.attachments);
        if (!sameContent) throw new Error("message identifier reused with different content");
        return { seq: old.seq, duplicate: true, session: old.session, project: old.project };
      }
      const result = this.db.query(`INSERT INTO channel_inbox(channel,account,thread,message_id,sender,sent_at,payload,session,project,received_at,original) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?7)`).run(message.channel,message.account,message.thread,message.messageId,message.sender,message.sentAt,payload,binding.session,binding.project,Date.now());
      return { seq: Number(result.lastInsertRowid), duplicate: false, session: binding.session, project: binding.project };
    }).immediate();
  }
  /** Transcription remains attached to the original message, never a new task. */
  transcript(seq: number, attachmentId: string, text: string, state: "complete" | "uncertain" | "failed"): void {
    if (!Number.isSafeInteger(seq) || seq < 1 || !bounded(attachmentId) || Buffer.byteLength(text) > 64_000 || !["complete","uncertain","failed"].includes(state)) throw new Error("invalid transcript update");
    this.db.transaction(() => {
      const row = this.db.query("SELECT payload FROM channel_inbox WHERE seq=?1").get(seq) as { payload: string } | null;
      if (!row) throw new Error("original message missing");
      const message = JSON.parse(row.payload) as Inbound;
      const attachment = message.attachments.find(a => a.id === attachmentId && a.kind === "audio");
      if (!attachment) throw new Error("original audio attachment missing");
      if (attachment.transcriptionState !== "pending") throw new Error("transcription is already resolved; explicit correction required");
      attachment.transcript = text; attachment.transcriptionState = state;
      const payload = JSON.stringify(message);
      if (Buffer.byteLength(payload) > 256_000) throw new Error("transcript exceeds message cap");
      this.db.query("UPDATE channel_inbox SET payload=?2 WHERE seq=?1").run(seq,payload);
      // Same transaction: an acknowledged audio message must not lose its later
      // transcript. This update references the original route, never a new task.
      this.db.query("INSERT INTO channel_updates(inbox_seq,attachment_id,state,created_at) VALUES(?1,?2,?3,?4)").run(seq,attachmentId,state,Date.now());
    }).immediate();
  }
  read(after: number, limit = 100) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid inbox cursor");
    return this.db.query(`SELECT seq,channel,account,thread,message_id,sent_at,payload,session,project FROM channel_inbox WHERE seq>?1 ORDER BY seq LIMIT ?2`).all(after, limit);
  }
  /** Transcript completion feed independent of message-delivery checkpoints.
   * The projection carries the original accepted session/project and current
   * payload. It does not replay acceptance or grant authority to launch work.
   */
  updates(after: number, limit = 100) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid inbox update cursor");
    return this.db.query(`SELECT u.update_seq,u.inbox_seq,u.attachment_id,u.state,u.created_at,
      i.channel,i.account,i.thread,i.message_id,i.payload,i.session,i.project
      FROM channel_updates u JOIN channel_inbox i ON i.seq=u.inbox_seq
      WHERE u.update_seq>?1 ORDER BY u.update_seq LIMIT ?2`).all(after,limit);
  }
  /** Durable at-least-once handoff. No task launch, cursor advancement or content approval. */
  pending(consumer: string, limit = 100) {
    if (!bounded(consumer) || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid inbox consumer");
    const checkpoint = this.db.query("SELECT cursor FROM channel_consumers WHERE consumer=?1").get(consumer) as { cursor: number } | null;
    const cursor = checkpoint?.cursor ?? 0;
    return { cursor, messages: this.read(cursor,limit) };
  }
  /** Advance only the next delivery after the caller confirms its durable handoff.
   * Compare-and-set protects concurrent consumers and uncertain acknowledgements.
   * Sender/session/project are the immutable accepted route, not current rebinding.
   */
  acknowledge(consumer: string, expected: number, delivery: { seq: number; session: string; project: string }): void {
    if (!bounded(consumer) || !Number.isSafeInteger(expected) || expected < 0
      || !Number.isSafeInteger(delivery.seq) || delivery.seq <= expected
      || !bounded(delivery.session) || !bounded(delivery.project)) throw new Error("invalid inbox acknowledgement");
    this.db.transaction(() => {
      const row = this.db.query("SELECT cursor FROM channel_consumers WHERE consumer=?1").get(consumer) as { cursor: number } | null;
      if ((row?.cursor ?? 0) !== expected) throw new Error("stale inbox acknowledgement; inspect checkpoint before retrying");
      const next = this.db.query("SELECT seq,session,project FROM channel_inbox WHERE seq>?1 ORDER BY seq LIMIT 1").get(expected) as { seq: number; session: string; project: string } | null;
      if (!next || next.seq !== delivery.seq || next.session !== delivery.session || next.project !== delivery.project) throw new Error("acknowledgement does not match next accepted route");
      this.db.query("INSERT INTO channel_consumers(consumer,cursor) VALUES(?1,?2) ON CONFLICT(consumer) DO UPDATE SET cursor=excluded.cursor").run(consumer,delivery.seq);
    }).immediate();
  }
  /** A new consumer starts at the present: its cursor begins at the newest
   * accepted seq, so history accepted before it first ran is never replayed.
   * An existing cursor is never touched. Returns the (possibly fresh) cursor. */
  sync(consumer: string): number {
    if (!bounded(consumer)) throw new Error("invalid inbox consumer");
    return this.db.transaction(() => {
      const existing = this.db.query("SELECT cursor FROM channel_consumers WHERE consumer=?1").get(consumer) as { cursor: number } | null;
      if (existing) return existing.cursor;
      const newest = this.db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM channel_inbox").get() as { seq: number };
      this.db.query("INSERT INTO channel_consumers(consumer,cursor) VALUES(?1,?2)").run(consumer, newest.seq);
      return newest.seq;
    }).immediate();
  }
  close() { this.db.close(); }
}
