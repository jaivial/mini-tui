/**
 * The channel consumer: turns accepted inbox rows into real mini session turns
 * and their replies into outbound WhatsApp messages.
 *
 * Per docs/channel-consumers.md this is at-least-once handoff, so every step is
 * ordered around the two durable cursors:
 *
 *   1. `ChannelInbox.pending(consumer)` is read-only; nothing has happened yet.
 *   2. The agent turn runs in the binding's session (create-or-resume, the same
 *      sessions.db every UI shares) and the transcript is saved there.
 *   3. The reply is recorded in the send ledger (keyed by the accepted seq)
 *      BEFORE the HTTP call, sent as a quoted reply, and only a confirmed send
 *      plus `acknowledge(consumer, cursor, {seq, session, project})` advances
 *      the inbox cursor — one CAS step, one message, never a skip.
 *
 * A failed send never acknowledges the cursor. An uncertain send (timeout, or
 * any non-201 — the fork's 201 is the only success and carries a server
 * generated id) is resolved by evidence: the thread's recent outgoing history
 * is read and a resend happens only when the reply is provably absent. A crash
 * at any point replays the same message with no lost message and no duplicated
 * reply: `sent` in the ledger skips the resend; `sending`/`uncertain` verifies.
 *
 * Processing is strictly sequential (one turn at a time) with bounded backoff —
 * no model polling, no unbounded concurrency. Messages accepted before the
 * consumer first ran are never replayed: `ChannelInbox.sync` starts a new
 * consumer at the present.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { runHeadless, type HeadlessResult } from "../cli/headless";
import { DEFAULT_DB_PATH, createSession, fallbackTitle, findSession, getSession, openDb, updateSession } from "../sessions";
import { mentionsAccount } from "./accounts";
import type { ChannelInbox, Inbound, Attachment } from "./inbox";
import type { EvoSender, SendLedger } from "./evoSend";
import type { QueueBridge } from "./queueBridge";
import type { GroupPlan } from "./groupBridge";
import type { SessionCommandPlan } from "./sessionCommand";
import type { RenameCommandPlan } from "./renameCommand";
import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { ensureMediaFrames, lateTranscriptNote, transcribePendingAudio, type LateTranscriptLog, type MediaHandling } from "./mediaTurn";

export interface PendingRow {
  seq: number;
  channel: string;
  account: string;
  thread: string;
  message_id: string;
  sent_at: number;
  payload: string;
  session: string;
  project: string;
}

export interface ConsumerOptions {
  inbox: ChannelInbox;
  sender: EvoSender;
  ledger: SendLedger;
  consumer: string;
  /** The sessions.db every UI shares (MINITUI_DB_PATH). */
  sessionsDbPath?: string;
  /** Working directory of the agent turns (per binding project by default). */
  cwd?: string;
  /** Model for new sessions; empty = the repo default chain. */
  model?: string;
  /** Per-account identity map (WA-5): the account's own jid for the group
   * mention gate, and that account's sender when `senderFor` is absent. */
  accountJids?: Map<string, string | undefined>;
  /** Sender per owning account. Absent = every row uses `sender` (single-account). */
  senderFor?: (account: string) => EvoSender | undefined;
  /** Agent turn wall-clock limit in seconds (the runner aborts past it). */
  turnTimeoutS?: number;
  idleMs?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Turn attempts before an honest failure note is sent instead. */
  maxTurnAttempts?: number;
  /** Attachment handling (audio transcription, honest image/document frames).
   * Absent = the plain-text-only behavior. */
  media?: MediaHandling;
  /** Durable record of late-transcript follow-up notes already delivered. */
  lateTranscripts?: LateTranscriptLog;
  /** Settle delay before the second absence check that earns a resend. */
  settleMs?: number;
  /** Chat ↔ queue bridge: directives in replies become queue work; optional. */
  queueBridge?: Pick<QueueBridge, "planReply">;
  /** Group-session bridge (WA-5): strips [[mini-newgroup: …]] from the reply
   * and returns the deferred creation flow; optional. */
  planGroupCreation?: (row: PendingRow, message: Inbound, replyText: string) => GroupPlan;
  /** Operator chat command (v4-H): recognizes `/newsession <subject>` in an
   * accepted row; a non-null plan is handled with NO model turn. Optional. */
  planSessionCommand?: (row: PendingRow, message: Inbound) => SessionCommandPlan | null;
  /** Operator chat command (v5-A): recognizes `/rename <title>` in an accepted
   * row; a non-null plan renames the session (and the group subject) with NO
   * model turn. Optional. */
  planRenameCommand?: (row: PendingRow, message: Inbound) => RenameCommandPlan | null;
  /** v5-A: best-effort AI title for a fresh session's first message (the same
   * helper the web server uses). Absent = the fallback title stays. */
  generateSessionTitle?: (task: string, model: string, onTitle: (title: string) => void) => void;
  /** v5-A: rename the bound group's subject to match the session title. */
  renameGroupSubject?: (account: string, groupJid: string, subject: string) => Promise<void>;
  /** Espejo (mirror): a message the consumer acks WITHOUT a turn (a gated
   * group message, a chat command) still belongs on the bound session's web
   * transcript. The sink appends the mirror row (media best-effort) — it is
   * data for the web only, never a prompt. Optional. */
  mirrorIn?: (row: PendingRow, message: Inbound) => Promise<void>;
  /** v4-F: strips [[mini-image: <path>]] markers from the reply and returns
   * the validated screenshot paths to deliver as media. Optional. */
  planImages?: (row: PendingRow, message: Inbound, replyText: string) => { text: string; images: string[] };
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---- [[mini-image: <path>]] markers (v4-F) -------------------------------------

const IMAGE_MARKER = /\[\[mini-image:\s*([^\]]+)\]\]/g;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MAX_PER_REPLY = 4;

export const cuPoolDir = (): string => process.env.MINITUI_CU_POOL_DIR || join(homedir(), ".local/share/mini-tui/cu-pool");

/** Strip the markers and validate each path: only regular PNGs inside the
 * cu pool dir (the computer_use tool's own shots) are deliverable — a model
 * can never attach an arbitrary file from the host. */
export function planImageMarkers(replyText: string, poolDir: string): { text: string; images: string[] } {
  const images: string[] = [];
  let last = 0;
  const chunks: string[] = [];
  const root = resolve(poolDir);
  for (const match of replyText.matchAll(IMAGE_MARKER)) {
    chunks.push(replyText.slice(last, match.index));
    last = match.index + match[0].length;
    const raw = (match[1] ?? "").trim();
    if (images.length >= IMAGE_MAX_PER_REPLY) continue;
    const abs = resolve(raw);
    if (!abs.startsWith(root + sep)) continue;
    if (!abs.endsWith(".png")) continue;
    try {
      const meta = statSync(abs);
      if (!meta.isFile() || meta.size > IMAGE_MAX_BYTES) continue;
      if (images.includes(abs)) continue;
      images.push(abs);
    } catch {
      continue;
    }
  }
  chunks.push(replyText.slice(last));
  return { text: chunks.join("").replace(/\n{3,}/g, "\n\n").trim(), images };
}

// ---- espejo (WhatsApp → web, no-turn messages) ----------------------------

/** Mirror one message the consumer will NOT turn on. Best-effort by
 * contract: a mirror failure is logged and the ack proceeds — the cursor
 * never blocks on a browser's transcript. */
async function mirrorNoTurn(
  options: ConsumerOptions,
  log: (event: string, fields?: Record<string, unknown>) => void,
  row: PendingRow,
  message: Inbound,
): Promise<void> {
  if (!options.mirrorIn) return;
  try {
    await options.mirrorIn(row, message);
  } catch (error) {
    log("channel.mirror.error", { seq: row.seq, session: row.session, error: error instanceof Error ? error.message : String(error) });
  }
}

/** The sender that speaks AS this row's account. Identity hygiene: a message
 * accepted for account A is never answered with account B's instance token.
 * No per-account map (single-account deployments) resolves to `sender`. */
function senderForAccount(options: ConsumerOptions, account: string): EvoSender {
  const resolved = options.senderFor?.(account);
  if (resolved) return resolved;
  if (options.senderFor) throw new Error(`no sender configured for account ${account}`);
  return options.sender;
}

/** The prompt the session's agent actually sees. Transport metadata is framed as
 * data: an inbound message is never a grant to act as the sender. Directives at
 * the very end hand work to the background queue; the bridge strips them before
 * anything is sent, and acts on them with its own deterministic rules. */
export function turnPrompt(message: Inbound, mediaFrames: string[] = []): string {
  return [
    `[WhatsApp message received in bound thread ${message.thread} — sender ${message.sender}]`,
    message.text,
    ...mediaFrames,
    "",
    "Reply with your answer as your final plain-text answer; it is sent back to this chat",
    "as a quoted reply. Answer in the sender's language, concise enough for a chat message.",
    "",
    "To hand work to the background queue you may end your reply with exactly ONE directive",
    "on its own last line — never inside the visible answer:",
    "[[mini-queue: <concise, self-contained goal>]] when the sender asks for work to be done in the background;",
    "[[mini-followup: <what to add or correct>]] when the sender adds to or corrects earlier queued work;",
    "[[mini-status]] when the sender only asks about the state of queued work.",
    "When the sender explicitly asks to start a brand-new dedicated session (\"nueva sesión\",",
    "\"new chat\"), end the reply with [[mini-newgroup: <short subject for the new chat>]] instead:",
    "a new isolated WhatsApp group bound to a fresh session is created for them.",
    "The bridge removes the directive line before sending and confirms the queueing itself.",
    "When the message is purely conversational, emit no directive.",
  ].join("\n");
}

export function startChannelConsumer(options: ConsumerOptions): { done: Promise<void>; stop: () => void } {
  const log = options.log ?? (() => {});
  const consumer = options.consumer;
  const idleMs = options.idleMs ?? 2_000;
  const baseBackoff = options.backoffMs ?? 1_000;
  const maxBackoff = options.maxBackoffMs ?? 60_000;
  const maxTurnAttempts = options.maxTurnAttempts ?? 2;
  let stopped = false;
  let wake: (() => void) | null = null;
  const done = (async () => {
    // A new consumer starts at the present: history accepted before it existed
    // is never replayed (five stale rows would each become a live agent turn).
    const cursor = options.inbox.sync(consumer);
    log("channel.consumer.start", { consumer, cursor });
    let backoff = baseBackoff;
    let lastLateSweep = 0;
    while (!stopped) {
      try {
        const { cursor, messages } = options.inbox.pending(consumer, 1);
        if (!messages.length) {
          backoff = baseBackoff;
          await lateTranscriptSweep(options, log, consumer, () => (lastLateSweep = Date.now()), lastLateSweep);
          await Promise.race([sleep(idleMs), new Promise<void>((r) => (wake = r))]);
          continue;
        }
        await processOne(options, log, consumer, cursor, messages[0] as PendingRow, maxTurnAttempts);
        backoff = baseBackoff;
      } catch (error) {
        log("channel.consumer.error", { consumer, error: error instanceof Error ? error.message : String(error) });
        await sleep(backoff);
        backoff = Math.min(maxBackoff, backoff * 2);
      }
    }
    log("channel.consumer.stop", { consumer });
  })();
  return {
    done,
    stop: () => {
      stopped = true;
      wake?.();
    },
  };
}

async function processOne(
  options: ConsumerOptions,
  log: (event: string, fields?: Record<string, unknown>) => void,
  consumer: string,
  cursor: number,
  row: PendingRow,
  maxTurnAttempts: number,
): Promise<void> {
  const message = JSON.parse(row.payload) as Inbound;
  const seq = row.seq;
  const ack = () => options.inbox.acknowledge(consumer, cursor, { seq, session: row.session, project: row.project });
  const sender = senderForAccount(options, row.account);

  // Per-turn operator state (WA-5): the binding is read fresh so CLI changes
  // apply immediately. The group mention gate uses its policy; every turn uses
  // its model. An unbound row cannot exist past accept(), so this only fails
  // if the binding was removed mid-flight — then the default chain applies.
  const binding = options.inbox.bindingFor("whatsapp", row.account, row.thread);

  // Own-send echo guard (v4-H): in groups the operator's real sends AND the
  // bot's own API replies share one number and arrive with fromMe=true. A
  // delivered id proven present in the thread's outgoing history is OUR send —
  // acknowledge it unread-by-any-model instead of answering ourselves (the
  // ledgered replies were already refused at the receiver). History unreadable
  // fails open: the operator's message must still turn, and the allowlist and
  // the mention gate still bound what a stray echo could trigger.
  if (message.fromMe && row.thread.endsWith("@g.us")) {
    let own = false;
    try {
      const recent = await sender.recentOutgoing(row.thread, 25);
      own = recent.length < 25 && recent.some((m) => m.id === message.messageId);
    } catch (error) {
      log("channel.consumer.own_send_history_error", { seq, error: error instanceof Error ? error.message : String(error) });
    }
    if (own) {
      log("channel.consumer.own_send_ignored", { seq, thread: row.thread });
      ack();
      return;
    }
  }

  // Operator chat command (v4-H): `/newsession` creates a fresh isolated
  // group session with no model turn. The planner is authority-checked
  // (allowlist only); handled rows are acknowledged before the deferred
  // creation runs, so a crash mid-creation replays nothing.
  const commandPlan = options.planSessionCommand?.(row, message);
  if (commandPlan) {
    await mirrorNoTurn(options, log, row, message);
    ack();
    void (async () => {
      try {
        await commandPlan.after();
      } catch (error) {
        log("channel.session_command.error", { seq, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return;
  }

  // Operator chat command (v5-A): `/rename <title>` renames the session (and
  // the group subject) with no model turn, exactly the same authority shape:
  // allowlist only, acknowledged before the deferred work runs.
  const renamePlan = options.planRenameCommand?.(row, message);
  if (renamePlan) {
    await mirrorNoTurn(options, log, row, message);
    ack();
    void (async () => {
      try {
        await renamePlan.after();
      } catch (error) {
        log("channel.rename_command.error", { seq, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return;
  }

  // Group mention gate (WA-5): a bound group thread answers only when the
  // account's own jid is explicitly mentioned, unless the operator set policy
  // "all". Ignored messages are acknowledged unread-by-any-model — the cursor
  // never blocks on a group that did not ask for the bot.
  if (row.thread.endsWith("@g.us")) {
    const gated = (binding?.policy ?? "") !== "all" && !mentionsAccount(message.mentions, options.accountJids?.get(row.account));
    if (gated) {
      log("channel.consumer.group_ignored", { seq, thread: row.thread, account: row.account, reason: options.accountJids?.get(row.account) ? "no_mention" : "no_jid_configured" });
      // Espejo: this message will never reach the session's journal (no turn
      // runs), so the web transcript learns of it through the mirror store.
      await mirrorNoTurn(options, log, row, message);
      ack();
      return;
    }
  }

  // Crash between send and acknowledge: the reply is already out — skip it.
  const entry = options.ledger.get(seq);
  if (entry?.state === "sent") {
    log("channel.consumer.already_sent", { seq });
    ack();
    return;
  }
  // Uncertain send: inspect the thread's history before ever resending.
  if (entry && entry.replyText) {
    const deliverCheck = async () => findDeliveredReply(sender, row.thread, entry.quotedId, entry.replyText);
    let delivered = await deliverCheck();
    if (!delivered) {
      // The reply may still be in flight from the uncertain attempt: settle,
      // then re-check. Only absence twice in a row earns a resend.
      await sleep(options.settleMs ?? 5_000);
      delivered = await deliverCheck();
    }
    if (delivered) {
      log("channel.consumer.verified_sent", { seq, replyId: delivered });
      options.ledger.markSent(seq, delivered);
      ack();
      return;
    }
  }

  const quotedId = entry?.quotedId ?? message.replyTo ?? message.messageId;
  let replyText = entry?.replyText ?? "";
  let imagePlan: { text: string; images: string[] } = { text: "", images: [] };
  let mediaFrames: string[] = [];
  if (!replyText) {
    // Attachments resolve BEFORE the turn: the transcript is durable by then,
    // so a crash replays with the transcript already attached to the message.
    // (A send-retry pass with a stored reply skips this: the late sweep owns
    // any attachment left pending by the first pass.)
    if (options.media && message.attachments.length) {
      mediaFrames = await ensureMediaFrames(options.media, options.inbox, log, seq, message);
    }
    const turn = await runTurn(options, log, row, message, maxTurnAttempts, mediaFrames, binding?.model || undefined);
    // Directives leave the reply here: what is journalled and sent is pure chat.
    const planned = options.queueBridge?.planReply(row, message, turn) ?? { text: turn };
    // Group-session directive (WA-5) is parsed from what survives the queue
    // bridge; both bridges' deferred work runs behind the cursor.
    const groupPlanned = options.planGroupCreation?.(row, message, planned.text) ?? { text: planned.text };
    // [[mini-image: <path>]] markers (v4-F) leave the text; the validated
    // screenshots ride along as media, sent best-effort after the reply.
    const imagePlanParsed = options.planImages?.(row, message, groupPlanned.text) ?? { text: groupPlanned.text, images: [] };
    imagePlan = imagePlanParsed;
    replyText = imagePlanParsed.text;
    // The reply carries the transcript frames (or their honest per-attachment
    // failure notes): mark delivered so the late sweep never re-sends them as
    // a follow-up. A turn that ended in the generic failure note carried
    // nothing — those attachments stay unmarked and the sweep relays them.
    if (options.media && options.lateTranscripts && !replyText.startsWith("(mini could not complete this turn")) {
      const freshRow = options.inbox.read(seq - 1, 1)[0] as PendingRow | undefined;
      if (freshRow?.seq === seq) {
        for (const a of (JSON.parse(freshRow.payload) as Inbound).attachments) {
          if (a.kind === "audio" && a.transcriptionState && a.transcriptionState !== "pending") options.lateTranscripts.mark(seq, a.id);
        }
      }
    }
    options.ledger.begin(seq, replyText, quotedId);
    const deferredSteps = [planned.after, groupPlanned.after].filter((step): step is () => Promise<void> => !!step);
    if (deferredSteps.length) {
      // Deferred bridge work (queue put, follow-up routing, status reports,
      // group creation) runs behind the reply path — never before the cursor
      // can advance.
      const runAfter = async () => {
        for (const step of deferredSteps) await step();
      };
      void (async () => {
        try {
          await runAfter();
        } catch (error) {
          log("channel.queue.deferred_error", { seq, error: error instanceof Error ? error.message : String(error) });
        }
      })();
    }
  }

  const outcome = await sender.sendText({
    number: row.thread,
    text: replyText,
    quoted: { id: quotedId, remoteJid: row.thread, ...(message.sender ? { participant: message.sender } : {}) },
  });
  if (outcome.kind === "sent") {
    options.ledger.markSent(seq, outcome.replyId);
    log("channel.consumer.sent", { seq, replyId: outcome.replyId, session: row.session });
    ack();
    // Best-effort image delivery (v4-F): the text reply is already durable and
    // the cursor advanced, so a failed screenshot send is logged, never a
    // redelivery loop — the model can re-take the shot on the next request.
    for (const image of imagePlan.images) {
      try {
        const sent = await sender.sendImage({ number: row.thread, mediaBase64: readFileSync(image).toString("base64") });
        log("channel.consumer.image_" + sent.kind, { seq, image: image, replyId: sent.kind === "sent" ? sent.replyId : undefined, error: sent.kind === "uncertain" ? sent.error.slice(0, 160) : undefined });
      } catch (error) {
        log("channel.consumer.image_failed", { seq, image, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return;
  }
  // Unknown whether the reply landed: the cursor stays put and the next pass
  // resolves it by evidence (or resends when the history proves absence). A
  // definitive 4xx was rejected before any send and can only be fixed by the
  // operator — by contract the cursor never advances on a failed send, so the
  // retry continues at the slow backoff floor and every attempt is logged
  // (markUncertain bumps the ledger's attempts on every pass).
  options.ledger.markUncertain(seq);
  const attempts = (entry?.attempts ?? 0) + 1;
  if (outcome.definitive && attempts >= 10) log("channel.consumer.send_rejected_operator_action", { seq, attempts, status: outcome.status, error: outcome.error.slice(0, 200) });
  log("channel.consumer.send_uncertain", { seq, definitive: outcome.definitive || undefined, status: outcome.status, error: outcome.error.slice(0, 200) });
  throw new Error(`send uncertain for seq ${seq}: ${outcome.error.slice(0, 120)}`);
}

/** Recent-window bound for text-based evidence: a reply counts as delivered by
 * text match only if it was sent recently (an old look-alike is not evidence). */
const RECENT_MATCH_WINDOW_S = 15 * 60;
const toSeconds = (ts: number) => (ts > 1e12 ? ts / 1000 : ts);

/** Does the thread's recent outgoing history already carry this reply?
 * Throws when absence cannot be proven (history unreadable, an empty window,
 * or the bounded window saturated — any of those leaves "maybe delivered"). */
async function findDeliveredReply(sender: EvoSender, thread: string, quotedId: string | null, replyText: string, limit = 50): Promise<string | null> {
  let recent: Array<{ id: string; text: string; quotedStanzaId: string | null; ts: number | null }>;
  try {
    recent = await sender.recentOutgoing(thread, limit);
  } catch (error) {
    // History unreadable (instance closed, transport down): assume nothing.
    throw new Error(`cannot verify pending send: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (recent.length >= limit) throw new Error("evidence window saturated; absence unproven");
  if (recent.length === 0) throw new Error("empty evidence window; absence unproven");
  const nowS = Date.now() / 1000;
  const recentText = (m: { ts: number | null }) => m.ts !== null && nowS - toSeconds(m.ts) < RECENT_MATCH_WINDOW_S;
  // Honest failure notes are intentionally generic: two messages can fail with
  // the byte-identical note, so a note is never text-evidence — only its quoted
  // stanza id (when present) may identify it. Text evidence is for real replies.
  const textEvidenceAllowed = !replyText.startsWith("(mini could not complete this turn");
  for (const m of recent) {
    if (quotedId) {
      if (m.quotedStanzaId === quotedId) return m.id || null;
      // A stored reply whose contextInfo went missing (normalization gaps) must
      // still count as delivered: quote absent-or-equal, same text, recent.
      if (textEvidenceAllowed && (m.quotedStanzaId == null || m.quotedStanzaId === quotedId) && m.text === replyText && recentText(m)) return m.id || null;
    } else if (textEvidenceAllowed && m.text === replyText && recentText(m)) {
      return m.id || null;
    }
  }
  return null;
}

/** v5-A: a fresh WhatsApp session's AI title, fired once on its first message.
 * The fallback title (first words, already stored) is replaced best-effort; a
 * rename that lands meanwhile (web or `/rename`) is detected by the title no
 * longer being the fallback and wins. A bound group's subject follows. */
function scheduleFirstTurnTitle(
  options: ConsumerOptions,
  log: (event: string, fields?: Record<string, unknown>) => void,
  row: PendingRow,
  model: string,
  firstText: string,
  dbPath: string,
): void {
  const baseTitle = fallbackTitle(firstText);
  options.generateSessionTitle?.(firstText, model, (ai) => {
    if (!ai || ai === baseTitle) return;
    try {
      const db = openDb(dbPath);
      try {
        const record = getSession(db, row.session);
        // Renamed meanwhile (web sidebar or /rename): the operator's name stays.
        if (record && record.title !== baseTitle) return;
        updateSession(db, row.session, { title: ai });
      } finally {
        db.close();
      }
      log("channel.session.title", { session: row.session, title: ai, ai: true });
    } catch {
      // best-effort: the fallback title stays
    }
    if (row.thread.endsWith("@g.us")) {
      options.renameGroupSubject?.(row.account, row.thread, ai)?.catch((error) => {
        log("channel.session.group_title_failed", { session: row.session, error: error instanceof Error ? error.message : String(error) });
      });
    }
  });
}

/** One agent turn in the binding's session; resolves with the reply text.
 * Throws while the turn keeps failing (bounded retries, then an honest note). */
async function runTurn(
  options: ConsumerOptions,
  log: (event: string, fields?: Record<string, unknown>) => void,
  row: PendingRow,
  message: Inbound,
  maxTurnAttempts: number,
  mediaFrames: string[],
  bindingModel?: string,
): Promise<string> {
  const dbPath = options.sessionsDbPath ?? process.env.MINITUI_DB_PATH ?? DEFAULT_DB_PATH;
  const cwd = options.cwd ?? process.env.EVO_CONSUMER_CWD ?? join(homedir(), "wa-assistant");
  mkdirSync(cwd, { recursive: true });
  // The binding's model (operator CLI) wins; the consumer default is the
  // fallback. The choice persists with the session: it is saved on create and
  // re-applied on every resume so the conversation never silently drifts.
  const model = bindingModel || options.model || "";
  let lastError = "";
  for (let attempt = 1; attempt <= maxTurnAttempts; attempt++) {
    try {
      const db = openDb(dbPath);
      // The binding's session is the stable conversation: create the row on the
      // first message, reuse it (and its saved history) on every later one.
      const fresh = !getSession(db, row.session);
      const firstText = fresh ? message.text.replace(/\s+/g, " ").trim() : "";
      if (fresh) {
        // v5-A: the first message names the session right away (the truncated
        // fallback title); the AI title replaces it best-effort below.
        createSession(db, { id: row.session, cwd, model, task: `WhatsApp thread ${row.thread}`, title: firstText ? fallbackTitle(firstText) : undefined });
      }
      db.close();
      if (fresh && firstText) scheduleFirstTurnTitle(options, log, row, model, firstText, dbPath);
      // resumeId is always the binding's session: the first turn runs on the
      // (empty) row we just ensured, later turns continue its saved
      // conversation — one thread is one stable session, never a fork.
      const captured: string[] = [];
      const exitCode = await runHeadless(
        {
          command: "print",
          prompt: turnPrompt(message, mediaFrames),
          outputFormat: "json",
          verbose: false,
          quiet: true,
          continueLast: false,
          resumeId: row.session,
          noSession: false,
          compact: false,
          cwd,
          // The turn prompt is a transport frame (thread header, reply-format rules, queue
          // directives) around what the sender actually wrote. The agent classifies that frame
          // as work and would put a greeting through the goal-closure judge, so the raw text
          // travels beside it: `intent::channel_subject` classifies the sender's words, and a
          // chat turn answers in one turn instead of arguing with a closure verdict.
          env: { MINI_CHANNEL_SUBJECT: message.text },
          ...(options.sessionsDbPath ? { dbPath: options.sessionsDbPath } : {}),
          ...(model ? { model } : {}),
          ...(options.turnTimeoutS ? { timeout: options.turnTimeoutS } : {}),
        },
        {
          stdout: (text) => captured.push(text),
          stderr: () => {},
          readStdin: async () => null,
          color: false,
        },
      );
      const parsed = JSON.parse(captured.join("")) as HeadlessResult;
      if (exitCode === 0 && parsed.subtype === "success" && parsed.result.trim()) {
        log("channel.consumer.turn", { seq: row.seq, session: row.session, turn: "ok" });
        return parsed.result.trim();
      }
      lastError = parsed.error ?? parsed.exit_status ?? `exit ${exitCode}`;
      log("channel.consumer.turn", { seq: row.seq, session: row.session, turn: "failed", attempt, error: lastError.slice(0, 200) });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log("channel.consumer.turn", { seq: row.seq, session: row.session, turn: "error", attempt, error: lastError.slice(0, 200) });
    }
  }
  // The turn kept failing: an honest failure note is still a reply — better
  // than a silent thread or a poison message blocking the cursor forever.
  return `(mini could not complete this turn: ${lastError.slice(0, 180)})`;
}

const LATE_NOTE_WINDOW = 20;
const LATE_NOTE_MATCH_WINDOW_S = 60 * 60;

/** Late-transcript sweep (runs while idle, at most once per lateSweepMs):
 * messages the cursor has already passed can still carry pending audio (e.g.
 * weai was down during the turn). Retry them; a definitive transcript is
 * written through inbox.transcript — which records the durable channel_updates
 * row — and relayed to the thread as a short quoted follow-up, recorded in the
 * LateTranscriptLog so the note is not re-sent on every pass. */
async function lateTranscriptSweep(
  options: ConsumerOptions,
  log: (event: string, fields?: Record<string, unknown>) => void,
  consumer: string,
  markRan: () => void,
  lastRun: number,
): Promise<void> {
  const media = options.media;
  if (!media || !media.lateSweepMs || !media.client || !media.store || !media.transcriber) return;
  if (Date.now() - lastRun < media.lateSweepMs) return;
  markRan();
  try {
    const removed = media.store.sweep();
    if (removed) log("channel.media.sweep", { removed });
    // Read-only: only rows the cursor has already passed are ours here.
    const { cursor } = options.inbox.pending(consumer, 1);
    const rows = options.inbox.read(Math.max(0, cursor - 200), 200) as PendingRow[];
    for (const row of rows) {
      if (row.seq > cursor) continue;
      let message: Inbound;
      try {
        message = JSON.parse(row.payload) as Inbound;
      } catch {
        continue;
      }
      // Pass 1: retry anything still pending (transient failures, fetch outages).
      let mutated = false;
      for (const attachment of message.attachments) {
        if (attachment.kind !== "audio" || attachment.transcriptionState !== "pending" || !attachment.providerRef) continue;
        await transcribePendingAudio(media, options.inbox, log, row.seq, attachment as Attachment, message.thread);
        mutated = true;
      }
      // Pass 2 reads fresh state: pass 1 may have resolved the attachment.
      if (mutated) {
        const freshRow = options.inbox.read(row.seq - 1, 1)[0] as PendingRow | undefined;
        if (freshRow?.seq === row.seq) message = JSON.parse(freshRow.payload) as Inbound;
      }
      // Each row is sent with the identity of the account that owns it.
      const sender = senderForAccount(options, row.account);
      // Pass 2: relay any resolved transcript the sender has not received.
      // Transcripts delivered inline with the turn's reply were marked at
      // resolution time; this reaches attachments resolved after the message
      // was answered (fetch outage during the turn, transient tool failure).
      const resolvedAudio = message.attachments.filter((a) => a.kind === "audio" && a.transcriptionState && a.transcriptionState !== "pending");
      const many = resolvedAudio.length > 1;
      for (const attachment of resolvedAudio) {
        if (!options.lateTranscripts || options.lateTranscripts.delivered(row.seq, attachment.id)) continue;
        const state = attachment.transcriptionState as "complete" | "uncertain" | "failed";
        let note = lateTranscriptNote(attachment.transcript ?? "", state);
        // Two voice notes in one message would otherwise produce identical
        // notes quoting the same stanza — indistinguishable evidence.
        if (many) note = `${note} [${resolvedAudio.indexOf(attachment) + 1}/${resolvedAudio.length}]`;
        if (state !== "failed") {
          // Evidence before resend, same discipline as findDeliveredReply: a
          // saturated window proves nothing, and text evidence needs recency.
          try {
            const recent = await sender.recentOutgoing(row.thread, LATE_NOTE_WINDOW);
            if (recent.length >= LATE_NOTE_WINDOW) continue;
            const nowS = Date.now() / 1000;
            const already = recent.some((m) => (m.quotedStanzaId && m.quotedStanzaId === message.messageId && m.text === note) || (m.text === note && m.ts !== null && nowS - toSeconds(m.ts) < LATE_NOTE_MATCH_WINDOW_S));
            if (already) {
              options.lateTranscripts.mark(row.seq, attachment.id);
              log("channel.media.late_transcript", { seq: row.seq, attachmentId: attachment.id, state, already: true });
              continue;
            }
          } catch {
            // History unreadable: skip this pass rather than risk a duplicate.
            continue;
          }
        }
        const sent = await sender.sendText({
          number: row.thread,
          text: note,
          quoted: { id: message.messageId, remoteJid: row.thread, ...(message.sender ? { participant: message.sender } : {}) },
        });
        if (sent.kind === "sent") {
          options.lateTranscripts.mark(row.seq, attachment.id);
          log("channel.media.late_transcript", { seq: row.seq, attachmentId: attachment.id, state, replyId: sent.replyId });
        } else if (state === "failed") {
          // A generic failure note can never be text-evidenced (any look-alike
          // is indistinguishable): mark after the attempt — a rare duplicate
          // apology beats never delivering the reason at all.
          options.lateTranscripts.mark(row.seq, attachment.id);
          log("channel.media.late_transcript_uncertain", { seq: row.seq, attachmentId: attachment.id, marked: true, error: sent.error.slice(0, 160) });
        } else {
          // Uncertain with unique text: leave unmarked — the next sweep's
          // evidence check re-sends only on proven absence.
          log("channel.media.late_transcript_uncertain", { seq: row.seq, attachmentId: attachment.id, error: sent.error.slice(0, 160) });
        }
      }
    }
  } catch (error) {
    log("channel.media.sweep_error", { error: error instanceof Error ? error.message : String(error) });
  }
}
