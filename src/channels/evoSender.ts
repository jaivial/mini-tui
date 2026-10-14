/** Outbound WhatsApp sender for accepted inbox messages. The Evo API stays loopback-only. */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

export interface EvoSenderConfig {
  /** evo-weai base URL. Loopback only: the API is never exposed, so never a remote host. */
  baseUrl: string;
  instance: string;
  /** Global Evo api key from 0600 service configuration. Never logged, never returned. */
  apiKey: string;
  /** Per-request timeout. A request that outlives it has an UNKNOWN outcome, not a failed one. */
  timeoutMs?: number;
}

/** The origin a reply quotes: the accepted inbound message it answers. */
export interface ReplyOrigin {
  thread: string;
  /** The inbound message's own id, or the one it replied to. */
  quoteId: string;
  /** Group chats quote the participant, not the chat jid. */
  sender: string;
  isGroup: boolean;
  /** The inbound text, shown as the quoted reply preview. */
  text: string;
}

interface OutboundRow {
  inbox_seq: number;
  status: string;
  attempts: number;
  message_key: string | null;
  reply_sha256: string;
  thread: string;
  updated_at: number;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_TEXT = 60_000; // sendText accepts 65 536 bytes; stay under it with multibyte headroom
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export class EvoSendError extends Error {
  /**
   * `permanent`: the API answered and refused (a retry of the same bytes cannot
   * succeed). Otherwise the outcome is UNKNOWN — the message may or may not have
   * landed, so only a chat inspection may clear it, never a blind resend.
   */
  constructor(message: string, readonly permanent: boolean) {
    super(message);
  }
}

/**
 * Durable, at-most-once-per-reply sender. Every accepted message gets one row in
 * `channel_outbound`: `sending` from the moment a wire attempt starts, `sent` only
 * after the API's 201 (or a chat inspection that found the message already there).
 * A crash, a timeout or a lost response therefore can never produce a double send:
 * the next attempt inspects instead of resending.
 */
export class EvoSender {
  readonly db: Database;
  readonly #base: string;
  readonly #instance: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;

  constructor(db: Database, config: EvoSenderConfig) {
    const url = new URL(config.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid sender base URL");
    // The weai API holds the WhatsApp session: pointing it anywhere but the
    // loopback deployment would exfiltrate the channel.
    if (!LOOPBACK.has(url.hostname)) throw new Error("the Evo sender must stay loopback-only");
    if (!config.instance || config.instance.length > 256 || /[\x00-\x1f]/.test(config.instance)) throw new Error("invalid Evo instance");
    if (!config.apiKey || config.apiKey.length > 512) throw new Error("missing Evo sender credentials");
    this.db = db;
    this.#base = url.origin;
    this.#instance = config.instance;
    this.#apiKey = config.apiKey;
    this.#timeoutMs = Math.min(Math.max(config.timeoutMs ?? 15_000, 1_000), 60_000);
    db.exec(`CREATE TABLE IF NOT EXISTS channel_outbound(
      inbox_seq INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      message_key TEXT,
      reply_sha256 TEXT NOT NULL,
      thread TEXT NOT NULL,
      updated_at INTEGER NOT NULL);`);
  }

  /** True when this accepted message already has a durably confirmed send. */
  sent(seq: number): boolean {
    const row = this.db.query("SELECT status FROM channel_outbound WHERE inbox_seq=?1").get(seq) as { status: string } | undefined;
    return row?.status === "sent";
  }

  /**
   * Send `reply` into `origin.thread` as a quoted reply to the accepted message.
   * Returns `sentNow: false` when a previous attempt already delivered (any text):
   * the caller must then acknowledge without a second wire send.
   */
  async sendReply(seq: number, origin: ReplyOrigin, reply: string): Promise<{ sentNow: boolean; key: string | null }> {
    let text = reply.trim();
    if (!text) throw new EvoSendError("refusing to send an empty reply", true);
    while (Buffer.byteLength(text, "utf8") > MAX_TEXT) text = text.slice(0, Math.floor(text.length * 0.9));
    const reservation = this.db.transaction(() => {
      const row = this.db.query("SELECT status,attempts FROM channel_outbound WHERE inbox_seq=?1").get(seq) as Pick<OutboundRow, "status" | "attempts"> | undefined;
      if (row?.status === "sent") return null;
      this.db.query(`INSERT INTO channel_outbound(inbox_seq,status,attempts,message_key,reply_sha256,thread,updated_at)
        VALUES(?1,'sending',1,NULL,?2,?3,?4)
        ON CONFLICT(inbox_seq) DO UPDATE SET attempts=channel_outbound.attempts+1, reply_sha256=excluded.reply_sha256, updated_at=excluded.updated_at`)
        .run(seq, sha256(text), origin.thread, Date.now());
      return (row?.attempts ?? 0) + 1;
    })();
    if (reservation === null) return { sentNow: false, key: this.#keyOf(seq) };
    // A prior attempt may have landed even though its 201 never reached us: look
    // in the chat for our own words before risking a duplicate.
    if (reservation > 1) {
      const found = await this.#findOwn(origin, text);
      if (found) {
        this.#confirm(seq, found);
        return { sentNow: false, key: found };
      }
    }
    const quoted = origin.quoteId
      ? {
          key: {
            id: origin.quoteId,
            fromMe: false,
            remoteJid: origin.thread,
            ...(origin.isGroup && origin.sender ? { participant: origin.sender } : {}),
          },
          // The fork reads only this one field for the reply preview; anything
          // else in the client JSON is never re-encoded.
          message: { conversation: origin.text.slice(0, 512) },
        }
      : undefined;
    let response: Response;
    try {
      response = await fetch(`${this.#base}/message/sendText/${encodeURIComponent(this.#instance)}`, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: this.#apiKey },
        body: JSON.stringify({ number: origin.thread, text, ...(quoted ? { quoted } : {}) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      // No URL, no credentials, no reply text in the message: only the failure shape.
      const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "did not confirm";
      throw new EvoSendError(`sendText ${reason}; outcome unknown`, false);
    }
    if (response.status === 201) {
      const data = (await response.json().catch(() => null)) as { key?: { id?: unknown } } | null;
      const key = typeof data?.key?.id === "string" ? data.key.id : null;
      this.#confirm(seq, key);
      return { sentNow: true, key };
    }
    // Drain the (bounded) error body so the connection can be reused, but never
    // surface it: server error text is not for the log.
    await response.text().catch(() => "");
    throw new EvoSendError(`sendText refused with status ${response.status}`, response.status >= 400 && response.status < 500);
  }

  #keyOf(seq: number): string | null {
    const row = this.db.query("SELECT message_key FROM channel_outbound WHERE inbox_seq=?1").get(seq) as { message_key: string | null } | undefined;
    return row?.message_key ?? null;
  }

  #confirm(seq: number, key: string | null): void {
    this.db.query("UPDATE channel_outbound SET status='sent', message_key=?2, updated_at=?3 WHERE inbox_seq=?1").run(seq, key, Date.now());
  }

  /** Best-effort: a fromMe message in the thread, inside the last five minutes, word-identical. */
  async #findOwn(origin: ReplyOrigin, text: string): Promise<string | null> {
    try {
      const response = await fetch(`${this.#base}/chat/findMessages/${encodeURIComponent(this.#instance)}`, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: this.#apiKey },
        body: JSON.stringify({
          where: { key: { remoteJid: origin.thread, fromMe: true }, messageTimestamp: { gte: Math.floor((Date.now() - 300_000) / 1000) } },
          page: 1,
          offset: 50,
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) return null;
      const data = (await response.json().catch(() => null)) as { messages?: Array<{ key?: { id?: unknown }; message?: Record<string, any> }> } | null;
      for (const message of data?.messages ?? []) {
        const body = message.message?.conversation ?? message.message?.extendedTextMessage?.text;
        if (typeof body === "string" && body === text && typeof message.key?.id === "string") return message.key.id;
      }
    } catch {
      // Inspection is only ever an optimization over resending; the caller retries.
    }
    return null;
  }
}
