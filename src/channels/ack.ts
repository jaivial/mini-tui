/**
 * v5-E: the immediate acknowledgement.
 *
 * A slow turn used to look like a dead bot. Two signals fix that, and NEITHER
 * one is a hardcoded string:
 *
 *   1. An emoji reaction on the operator's message, the moment the turn is
 *      dispatched. Costs one API call and cannot collide with a reply.
 *   2. A one-line text acknowledgement WRITTEN BY THE MODEL — a tiny, cheap
 *      chatCompletion against the SAME provider the turn itself runs on, fired
 *      in parallel with it, carrying the sender's actual words.
 *
 * The 4s timer only decides WHETHER (2) is sent, never what it says. If the turn
 * finished first, the generated line is discarded and nothing is sent: a fast
 * answer is never diluted by "I'm on it". If the model call fails or overruns,
 * there is no canned fallback — the reaction alone is the signal and the reason
 * is logged. A canned string is the one thing this module must never produce:
 * an ack that says "vale" to a request about trains is worse than no ack.
 *
 * Every failure here is swallowed. The ack is decoration on a turn that must
 * run no matter what; it can delay nothing and break nothing.
 */

import type { Database } from "bun:sqlite";

import { loadConnections, type SavedConnection } from "../providers";

/** What a binding (or the consumer env) says about its acks. */
export interface AckConfig {
  /** The reaction fired on acceptance. "" disables it. */
  reaction: string;
  /** How long the turn may run before the line is sent. */
  delayMs: number;
  /** Wall-clock ceiling for the model call. Past it: reaction only. */
  modelTimeoutMs: number;
  /** Small, because a chat message is small (see the model's own answer). */
  maxTokens: number;
  /** Bound on the stored/generated line, so the prompt cannot smuggle a paragraph. */
  maxChars: number;
  /** How many times an EMPTY model answer is retried with a bigger budget.
   * Bounded on purpose: the reaction is already out, and a second miss means
   * reaction-only rather than a late, noisy ack. */
  escalations: number;
}

/** The deployed defaults: react instantly, speak at 4s, give up on the model
 * at 6s. The delay and the model budget are deliberately ordered so a healthy
 * provider is ready BEFORE the timer asks for the line. */
export const DEFAULT_ACK: AckConfig = {
  reaction: "👀",
  delayMs: 4_000,
  modelTimeoutMs: 6_000,
  maxTokens: 60,
  maxChars: 200,
  escalations: 2,
};

const MAX_SUBJECT_CHARS = 1_200;

/** The prompt. It names the task explicitly ("refer to what was asked") and
 * bans the three failure modes a small model actually produces: a generic
 * "vale", a claim of completion, and a promise it cannot keep. */
export const ACK_SYSTEM_PROMPT = [
  "You are a WhatsApp assistant that has just received a message and will answer it shortly.",
  "Write the ONE short line you send right now to tell the sender you received it.",
  "",
  "Rules:",
  "- Exactly one line, in the SAME language as the message.",
  "- Name what was actually asked, concretely (the subject, not \"your request\").",
  "- Maximum 80 characters.",
  "- No emoji, no quotation marks, no preamble, no explanation.",
  "- Do NOT say it is done or finished, do NOT invent results or facts.",
  "- Do NOT promise a specific time; \"I'll answer shortly\" is fine.",
  "- Reply with that line and nothing else.",
].join("\n");

/** Strip what a chat message must never carry: the model's framing wrappers,
 * quotes, and a trailing full stop. Keeps the first line only. Never throws. */
export function cleanAckLine(raw: string, maxChars: number = DEFAULT_ACK.maxChars): string {
  let line = (raw ?? "").split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  line = line
    .trim()
    // Models often wrap the answer in quotes or markdown emphasis.
    .replace(/^["'“”«`'*\s]+/, "")
    .replace(/["'“”«'`*\s]+$/, "")
    // …and a trailing period or ellipsis reads as a finished thought.
    .replace(/[.\u2026]+\s*$/, "")
    .trim();
  // A line that leaked its own framing ("Ack: …", "Assistant: …") is worse than none.
  line = line.replace(/^(?:ack|acuse|assistant|response|respuesta)\s*[:\-–]\s*/i, "").trim();
  if (Buffer.byteLength(line, "utf8") > maxChars) {
    // Cut on a character boundary, then drop a dangling half-word.
    const cut = line.slice(0, Math.floor(maxChars * 0.9));
    line = (cut.split(/\s+/).slice(0, -1).join(" ") || cut).trim();
  }
  return line;
}

/** Resolve a `<prefix>/<model>` mini model name against the saved connections.
 * Returns null when no connection owns it — the caller degrades to the reaction
 * rather than guessing at credentials. */
export function resolveAckConnection(modelName: string, connections: SavedConnection[] = loadConnections()): { connection: SavedConnection; model: string } | null {
  const name = (modelName ?? "").trim();
  if (!name) return null;
  for (const connection of connections) {
    const prefix = `${connection.prefix}/`;
    if (!name.startsWith(prefix)) continue;
    const model = name.slice(prefix.length);
    if (!model || !connection.baseUrl || !connection.key) continue;
    return { connection, model };
  }
  return null;
}

export interface AckLineResult {
  /** The generated line, or null when there is none to send. */
  line: string | null;
  /** Measured model latency in ms (0 when no call was made). */
  ms: number;
  model: string;
  /** Why there is no line, when there is none. */
  reason?: string;
}

/** Words that make a line say nothing about THIS message. A model that ignores
 * the "name what was asked" rule answers with one of these plus a verb, and
 * such a line is exactly the canned ack this feature exists to avoid — so it is
 * rejected and the attempt counts as a miss, same as an empty answer. */
const GENERIC_ACK_RE = /^(?:ok(?:ay)?|got it|gotcha|understood|received|noted|recibido|entendido|perfecto|vale|recibido!|listo|hecho|on it|working on it|sure|thank you|gracias)[.!¡…]*\s*$/i;

/** Is this line actually about the sender's message? A short subject can be
 * legitimately vague ("hola"), so the bar is LOW (12 characters) — but a line
 * that is pure boilerplate never passes, whatever its length. */
function isGenericAck(line: string): boolean {
  return GENERIC_ACK_RE.test(line.trim());
}

/** One cheap chatCompletion. Bounded by `timeoutMs`, capped at `maxTokens`, and
 * strict about what counts as a usable answer. Never throws.
 *
 * `enable_thinking: false` is what makes this fast: without it the reasoning
 * models spend the entire token budget on reasoning and return
 * `content: null` (measured: 40/80/160/300 tokens → all null). It is NOT
 * universally accepted though — some upstream routes reject the unknown
 * parameter with a 400 — so that exact failure retries once without it, and
 * only that failure. */
export async function generateAckLine(args: {
  subject: string;
  model: string;
  config?: Partial<AckConfig>;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}): Promise<AckLineResult> {
  const cfg = { ...DEFAULT_ACK, ...(args.config ?? {}) };
  const clock = args.now ?? Date.now;
  const started = clock();
  const subject = (args.subject ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT_CHARS);
  const resolved = resolveAckConnection(args.model);
  if (!subject || !resolved) {
    return { line: null, ms: 0, model: args.model, reason: !subject ? "empty_subject" : "unresolved_model" };
  }
  const { connection, model } = resolved;
  // The audit trail names the model the way the operator configured it
  // (`opencode-go/glm-5.3-flash`), not the provider-side id, so a ledger row
  // points back at a model that can be typed into `MINITUI_MODEL`.
  const auditModel = `${connection.prefix}/${model}`;
  const url = `${connection.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const payload = {
    model,
    messages: [
      { role: "system", content: ACK_SYSTEM_PROMPT },
      { role: "user", content: `Message from the user: ${subject}` },
    ],
    // No temperature: measured against the deployed gateway it made reliability
    // WORSE (glm-5.3-flash: 3/12 usable answers at 0.2 vs 5/12 unset, and the
    // failures are silent empty contents, not refusals). The line is short and
    // constrained by the prompt plus cleanAckLine, so the sampling knob buys
    // nothing here.
    max_tokens: cfg.maxTokens,
  };
  // opencode's gateway routes on this header (a missing one is a 400), and other
  // providers ignore unknown headers, so sending it is always safe.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${connection.key}`,
    "x-opencode-session": `mini-ack-${clock()}`,
  };

  const attempt = async (body: Record<string, unknown>): Promise<{ status: number; content: string; error: string }> => {
    // The deadline is the WHOLE ack budget, shared by every attempt: a line that
    // arrives after the turn is already 10s old is worse than no line. Measured
    // worst case before this was 7.1s of escalation alone.
    const left = cfg.modelTimeoutMs - (clock() - started);
    if (left <= 250) return { status: 0, content: "", error: "ack_budget_exhausted" };
    try {
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(left) });
      if (response.status === 200) {
        const data = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
        const content = data.choices?.[0]?.message?.content ?? "";
        // A 200 whose only content is boilerplate is a MISS, not a line: the
        // whole point is that the ack names what was asked.
        const line = content.trim() ? cleanAckLine(content, cfg.maxChars) : "";
        if (!line) return { status: 200, content: "", error: "empty_content" };
        if (isGenericAck(line)) return { status: 200, content: "", error: "generic_content" };
        return { status: 200, content: line, error: "" };
      }
      const text = await response.text().catch(() => "");
      return { status: response.status, content: "", error: `HTTP ${response.status}: ${text.slice(0, 160)}` };
    } catch (error) {
      return { status: 0, content: "", error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160) };
    }
  };

  let result = await attempt({ ...payload, enable_thinking: false });
  // Only that one rejection earns a retry: dropping the flag is slower but
  // still bounded, and it is the only way to serve a reasoning model here.
  if (result.status === 400 && /enable_thinking|unknown_param/i.test(result.error)) {
    args.log?.("channel.ack.retry_without_thinking_flag", { model: auditModel });
    result = await attempt({ ...payload, max_tokens: Math.max(cfg.maxTokens, cfg.maxTokens * 4) });
  }
  // A 200 that carries no usable line — empty (the reasoning models spent the
  // budget thinking) or pure boilerplate — is a MISS, and a miss escalates.
  // Measured against the deployed gateway (which load-balances across upstreams,
  // so this is bimodal): glm-5.3-flash returned usable content on only 3/12 and
  // 5/12 calls at 60 tokens, and a bigger budget alone did not fix it; the
  // sibling model on the same provider (qwen3.8-flash) answered 12/12. After
  // the last escalation a miss means reaction-only — never a canned line.
  for (let step = 0; result.status === 200 && !result.content && step < cfg.escalations; step++) {
    args.log?.("channel.ack.escalate", { model: auditModel, step: step + 1, reason: result.error });
    result = await attempt({ ...payload, max_tokens: cfg.maxTokens * (4 ** (step + 1)) });
  }
  const ms = clock() - started;
  // `attempt` already cleaned and vetted the text.
  const line = result.status === 200 ? result.content : "";
  if (!line) {
    args.log?.("channel.ack.model_failed", { model: auditModel, status: result.status || undefined, ms, reason: result.error || "empty_content" });
    return { line: null, ms, model: auditModel, reason: result.error || "empty_content" };
  }
  args.log?.("channel.ack.model_ok", { model: auditModel, ms, chars: line.length });
  return { line, ms, model: auditModel };
}

// ---- the audit ledger -------------------------------------------------------

/** What the operator can read back to answer "was that really generated?".
 * One row per accepted turn: what the model was asked, what it answered, what
 * was actually delivered to WhatsApp, and the measured latency of each. */
export interface AckRow {
  seq: number;
  reaction: string | null;
  reactionState: string;
  generated: string | null;
  sent: string | null;
  model: string | null;
  modelMs: number | null;
  sentMs: number | null;
  disposition: string;
  note: string | null;
  updatedAt: number;
}

/** Durable record of the ack lifecycle, keyed by the accepted inbox seq.
 *
 * `disposition` is the honest outcome: `sent` (delivered), `discarded` (the
 * turn beat the timer), `no_line` (the model gave nothing), `failed`. A row
 * with a `generated` value and no `sent` value is exactly the evidence that the
 * line was written by the model and then deliberately dropped. */
export class AckLedger {
  readonly db: Database;
  constructor(db: Database) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS channel_acks(
      inbox_seq INTEGER PRIMARY KEY,
      reaction TEXT,
      reaction_state TEXT NOT NULL DEFAULT 'pending',
      generated TEXT,
      sent TEXT,
      model TEXT,
      model_ms INTEGER,
      sent_ms INTEGER,
      disposition TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      updated_at INTEGER NOT NULL)`);
  }
  /** The reaction left (or provably did not). Recorded before any text work. */
  markReaction(seq: number, reaction: string, state: "sent" | "failed" | "skipped", note?: string): void {
    this.db.query(
      `INSERT INTO channel_acks(inbox_seq,reaction,reaction_state,disposition,note,updated_at) VALUES(?1,?2,?3,'pending',?4,?5)
       ON CONFLICT(inbox_seq) DO UPDATE SET reaction=excluded.reaction, reaction_state=excluded.reaction_state, note=excluded.note, updated_at=excluded.updated_at`,
    ).run(seq, reaction, state, note ?? null, Date.now());
  }
  /** The model's line exists (or provably does not). The generated text is kept
   * even when it is never sent: that is the audit trail. */
  markGenerated(seq: number, generated: string | null, model: string, modelMs: number): void {
    this.db.query(
      `INSERT INTO channel_acks(inbox_seq,generated,model,model_ms,disposition,updated_at) VALUES(?1,?2,?3,?4,'pending',?5)
       ON CONFLICT(inbox_seq) DO UPDATE SET generated=excluded.generated, model=excluded.model, model_ms=excluded.model_ms, updated_at=excluded.updated_at`,
    ).run(seq, generated, model, modelMs, Date.now());
  }
  /** The line reached WhatsApp (or was deliberately dropped), with the measured
   * delay from acceptance to that decision. */
  markDisposition(seq: number, disposition: "sent" | "discarded" | "no_line" | "failed", sent: string | null, sentMs: number | null, note?: string): void {
    this.db.query(
      `INSERT INTO channel_acks(inbox_seq,sent,model_ms,sent_ms,disposition,note,updated_at) VALUES(?1,?2,NULL,?3,?4,?5,?6)
       ON CONFLICT(inbox_seq) DO UPDATE SET sent=excluded.sent, sent_ms=excluded.sent_ms, disposition=excluded.disposition, note=excluded.note, updated_at=excluded.updated_at`,
    ).run(seq, sent, sentMs, disposition, note ?? null, Date.now());
  }
  get(seq: number): AckRow | null {
    const row = this.db.query("SELECT * FROM channel_acks WHERE inbox_seq=?1").get(seq) as Record<string, unknown> | null;
    return row && {
      seq: Number(row.inbox_seq),
      reaction: (row.reaction as string) ?? null,
      reactionState: String(row.reaction_state),
      generated: (row.generated as string) ?? null,
      sent: (row.sent as string) ?? null,
      model: (row.model as string) ?? null,
      modelMs: row.model_ms === null || row.model_ms === undefined ? null : Number(row.model_ms),
      sentMs: row.sent_ms === null || row.sent_ms === undefined ? null : Number(row.sent_ms),
      disposition: String(row.disposition),
      note: (row.note as string) ?? null,
      updatedAt: Number(row.updated_at),
    };
  }
  recent(limit = 50): AckRow[] {
    const rows = this.db.query("SELECT inbox_seq FROM channel_acks ORDER BY inbox_seq DESC LIMIT ?1").all(Math.max(1, Math.min(200, limit))) as Array<{ inbox_seq: number }>;
    return rows.map((r) => this.get(Number(r.inbox_seq))).filter((r): r is AckRow => !!r);
  }
}