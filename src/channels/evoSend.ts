/**
 * Outbound WhatsApp sender for accepted inbox messages, plus the durable send
 * ledger that makes re-delivery safe.
 *
 * Idempotency contract (docs/channel-consumers.md): delivery is at least once,
 * so a send side effect needs its own durable state keyed by the accepted inbox
 * seq. The ledger records the intent BEFORE the HTTP call; a non-201 response or
 * a timeout is `uncertain`, never "failed clean": the message may still have
 * landed (the 201 carries the server-generated id — the client cannot supply
 * one). After an uncertain outcome the consumer never blind-retries; it first
 * looks for the reply in the thread's recent outgoing history (`findMessages`)
 * and re-sends only when the evidence says the reply is absent. That proof, not
 * hope, closes the double-send window.
 */

import type { Database } from "bun:sqlite";

export type SendState = "sending" | "sent" | "uncertain";

export interface LedgerEntry {
  seq: number;
  state: SendState;
  replyText: string;
  quotedId: string | null;
  replyId: string | null;
  attempts: number;
  updated_at: number;
}

/** Durable per-message send state, keyed by the accepted inbox seq. */
export class SendLedger {
  readonly db: Database;
  constructor(db: Database) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS channel_sends(
      inbox_seq INTEGER PRIMARY KEY,
      state TEXT NOT NULL,
      reply_text TEXT NOT NULL,
      quoted_id TEXT,
      reply_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL)`);
  }
  get(seq: number): LedgerEntry | null {
    const row = this.db
      .query("SELECT inbox_seq,state,reply_text,quoted_id,reply_id,attempts,updated_at FROM channel_sends WHERE inbox_seq=?1")
      .get(seq) as { inbox_seq: number; state: SendState; reply_text: string; quoted_id: string | null; reply_id: string | null; attempts: number; updated_at: number } | null;
    return row && { seq: row.inbox_seq, state: row.state, replyText: row.reply_text, quotedId: row.quoted_id, replyId: row.reply_id, attempts: row.attempts, updated_at: row.updated_at };
  }
  /** Record the intent to send `replyText` before any HTTP call. */
  begin(seq: number, replyText: string, quotedId: string | null): void {
    this.db.query(
      `INSERT INTO channel_sends(inbox_seq,state,reply_text,quoted_id,reply_id,attempts,updated_at) VALUES(?1,'sending',?2,?3,NULL,1,?4)
       ON CONFLICT(inbox_seq) DO UPDATE SET state='sending', attempts=attempts+1, updated_at=excluded.updated_at`,
    ).run(seq, replyText, quotedId, Date.now());
  }
  markSent(seq: number, replyId: string | null): void {
    this.db.query("UPDATE channel_sends SET state='sent', reply_id=?2, updated_at=?3 WHERE inbox_seq=?1").run(seq, replyId, Date.now());
  }
  markUncertain(seq: number): void {
    this.db.query("UPDATE channel_sends SET state='uncertain', updated_at=?2 WHERE inbox_seq=?1").run(seq, Date.now());
  }
}

/** The evo-weai wire client: sendText with a quoted reply, and the recent
 * outgoing history the uncertainty check reads. Bounded, no internal retries —
 * retry policy belongs to the consumer loop. */
export interface EvoSender {
  sendText(args: { number: string; text: string; quoted?: { id: string; remoteJid: string; participant?: string } }): Promise<
    { kind: "sent"; replyId: string } | { kind: "uncertain"; status?: number; error: string; definitive: boolean }
  >;
  /** Newest outgoing messages of `thread`, newest first (bounded page). */
  recentOutgoing(thread: string, limit?: number): Promise<Array<{ id: string; text: string; quotedStanzaId: string | null; ts: number | null }>>;
}

/** The fork accepts 1..65536 bytes of text; keep a margin under the cap. */
export const MAX_SEND_TEXT_BYTES = 60_000;

export function truncateForSend(text: string): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= MAX_SEND_TEXT_BYTES) return text;
  return `${buffer.subarray(0, MAX_SEND_TEXT_BYTES).toString("utf8")}…`;
}

export function createEvoSender(config: { baseUrl: string; instance: string; token: string; timeoutMs?: number }): EvoSender {
  const base = config.baseUrl.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? 20_000;
  const call = async (path: string, body: unknown): Promise<{ status: number; json: any; error: string }> => {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: config.token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { status: 0, json: null, error: error instanceof Error ? error.message : String(error) };
    }
    let json: any = null;
    let error = "";
    try {
      json = await response.json();
    } catch {
      error = `non-JSON response (${response.status})`;
    }
    return { status: response.status, json, error };
  };
  return {
    async sendText({ number, text, quoted }) {
      // The fork serves one path per channel and picks Baileys for a
      // WHATSAPP-BAILEYS instance; quoted.key carries the quoted stanza id.
      const r = await call(`/message/sendText/${encodeURIComponent(config.instance)}`, {
        number,
        text: truncateForSend(text),
        ...(quoted ? { quoted: { key: { id: quoted.id, remoteJid: quoted.remoteJid, ...(quoted.participant ? { participant: quoted.participant } : {}) } } } : {}),
      });
      if (r.status === 201 && r.json?.key?.id) return { kind: "sent", replyId: String(r.json.key.id) };
      // 201 is the only success the fork returns; anything else (or a timeout /
      // connection reset) may or may not have delivered — verify before resending.
      // A 4xx was rejected by dispatch BEFORE any send: it can never land, so no
      // evidence pass can ever find it — flag it so the consumer treats the
      // retry as operator-actionable instead of "maybe delivered".
      const definitive = r.status >= 400 && r.status < 500;
      return { kind: "uncertain", definitive, status: r.status || undefined, error: r.error || (r.json ? JSON.stringify(r.json).slice(0, 300) : `status ${r.status}`) };
    },
    async recentOutgoing(thread, limit = 50) {
      const r = await call(`/chat/findMessages/${encodeURIComponent(config.instance)}`, {
        where: { key: { remoteJid: thread, fromMe: true } },
        page: 1,
        offset: Math.min(50, Math.max(1, limit)),
      });
      if (r.status !== 200 || !r.json) throw new Error(`findMessages failed: ${r.error || `status ${r.status}`}`);
      const messages = Array.isArray(r.json?.messages) ? r.json.messages : [];
      return messages.map((m: any) => ({
        id: String(m?.key?.id ?? ""),
        text: String(m?.message?.conversation ?? m?.message?.extendedTextMessage?.text ?? ""),
        quotedStanzaId: m?.message?.extendedTextMessage?.contextInfo?.stanzaId ? String(m.message.extendedTextMessage.contextInfo.stanzaId) : null,
        ts: typeof m?.messageTimestamp === "number" ? m.messageTimestamp : null,
      }));
    },
  };
}
