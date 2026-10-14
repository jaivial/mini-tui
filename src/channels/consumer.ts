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
import { DEFAULT_DB_PATH, createSession, findSession, getSession, openDb } from "../sessions";
import type { ChannelInbox, Inbound } from "./inbox";
import type { EvoSender, SendLedger } from "./evoSend";

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
  /** Agent turn wall-clock limit in seconds (the runner aborts past it). */
  turnTimeoutS?: number;
  idleMs?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Turn attempts before an honest failure note is sent instead. */
  maxTurnAttempts?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The prompt the session's agent actually sees. Transport metadata is framed as
 * data: an inbound message is never a grant to act as the sender. */
export function turnPrompt(message: Inbound): string {
  return [
    `[WhatsApp message received in bound thread ${message.thread} — sender ${message.sender}]`,
    message.text,
    "",
    "Reply with your answer as your final plain-text answer; it is sent back to this chat",
    "as a quoted reply. Answer in the sender's language, concise enough for a chat message.",
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
    while (!stopped) {
      try {
        const { cursor, messages } = options.inbox.pending(consumer, 1);
        if (!messages.length) {
          backoff = baseBackoff;
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

  // Crash between send and acknowledge: the reply is already out — skip it.
  const entry = options.ledger.get(seq);
  if (entry?.state === "sent") {
    log("channel.consumer.already_sent", { seq });
    ack();
    return;
  }
  // Uncertain send: inspect the thread's history before ever resending.
  if (entry && entry.replyText) {
    const delivered = await findDeliveredReply(options.sender, row.thread, entry.quotedId, entry.replyText);
    if (delivered) {
      log("channel.consumer.verified_sent", { seq, replyId: delivered });
      options.ledger.markSent(seq, delivered);
      ack();
      return;
    }
  }

  const quotedId = entry?.quotedId ?? message.replyTo ?? message.messageId;
  let replyText = entry?.replyText ?? "";
  if (!replyText) {
    const turn = await runTurn(options, log, row, message, maxTurnAttempts);
    replyText = turn;
    options.ledger.begin(seq, replyText, quotedId);
  }

  const outcome = await options.sender.sendText({
    number: row.thread,
    text: replyText,
    quoted: { id: quotedId, remoteJid: row.thread, ...(message.sender ? { participant: message.sender } : {}) },
  });
  if (outcome.kind === "sent") {
    options.ledger.markSent(seq, outcome.replyId);
    log("channel.consumer.sent", { seq, replyId: outcome.replyId, session: row.session });
    ack();
    return;
  }
  // Unknown whether the reply landed: the cursor stays put and the next pass
  // resolves it by evidence (or resends when the history proves absence).
  options.ledger.markUncertain(seq);
  log("channel.consumer.send_uncertain", { seq, status: outcome.status, error: outcome.error.slice(0, 200) });
  throw new Error(`send uncertain for seq ${seq}: ${outcome.error.slice(0, 120)}`);
}

/** Does the thread's recent outgoing history already carry this reply? */
async function findDeliveredReply(sender: EvoSender, thread: string, quotedId: string | null, replyText: string): Promise<string | null> {
  let recent: Array<{ id: string; text: string; quotedStanzaId: string | null }>;
  try {
    recent = await sender.recentOutgoing(thread, 20);
  } catch (error) {
    // History unreadable (instance closed, transport down): assume nothing.
    throw new Error(`cannot verify pending send: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const m of recent) {
    if (quotedId && m.quotedStanzaId && m.quotedStanzaId === quotedId) return m.id || null;
    if (!quotedId && m.text === replyText) return m.id || null;
  }
  return null;
}

/** One agent turn in the binding's session; resolves with the reply text.
 * Throws while the turn keeps failing (bounded retries, then an honest note). */
async function runTurn(
  options: ConsumerOptions,
  log: (event: string, fields?: Record<string, unknown>) => void,
  row: PendingRow,
  message: Inbound,
  maxTurnAttempts: number,
): Promise<string> {
  const dbPath = options.sessionsDbPath ?? process.env.MINITUI_DB_PATH ?? DEFAULT_DB_PATH;
  // runHeadless resolves the sessions db per call from this env (see headless.ts).
  if (options.sessionsDbPath) process.env.MINITUI_DB_PATH = options.sessionsDbPath;
  const cwd = options.cwd ?? process.env.EVO_CONSUMER_CWD ?? join(homedir(), "wa-assistant");
  mkdirSync(cwd, { recursive: true });
  const model = options.model ?? "";
  let lastError = "";
  for (let attempt = 1; attempt <= maxTurnAttempts; attempt++) {
    try {
      const db = openDb(dbPath);
      // The binding's session is the stable conversation: create the row on the
      // first message, reuse it (and its saved history) on every later one.
      if (!getSession(db, row.session)) createSession(db, { id: row.session, cwd, model, task: `WhatsApp thread ${row.thread}` });
      db.close();
      // resumeId is always the binding's session: the first turn runs on the
      // (empty) row we just ensured, later turns continue its saved
      // conversation — one thread is one stable session, never a fork.
      const captured: string[] = [];
      const exitCode = await runHeadless(
        {
          command: "print",
          prompt: turnPrompt(message),
          outputFormat: "json",
          verbose: false,
          quiet: true,
          continueLast: false,
          resumeId: row.session,
          noSession: false,
          compact: false,
          cwd,
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
