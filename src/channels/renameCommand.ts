/**
 * Operator chat command (v5-A): `/rename <new title>` typed in a bound thread
 * renames the session — and, when the thread is a WhatsApp group, the group's
 * subject with it — with NO model turn and NO prompt-injection surface:
 *
 *   - Authority is operator-grade configuration, never message content: the
 *     command only fires for a sender already on the thread's own allowlist
 *     (the exact same list the accept boundary enforces). Anyone else's
 *     "/rename …" is plain text for the normal turn.
 *   - The session title lives in the shared sessions.db, so the web sidebar
 *     shows the new name on its next metadata refresh (live sessions push it
 *     immediately).
 *   - A group-subject failure is honest but not fatal: the session keeps the
 *     new title and the thread is told the group part failed.
 *   - Handled rows are acknowledged BEFORE the deferred work runs: a crash
 *     mid-rename replays nothing (an operator re-runs the command instead).
 */

import type { Inbound } from "./inbox";
import type { PendingRow } from "./consumer";
import type { GroupBridgeOptions } from "./groupBridge";
import { setGroupSubject } from "./groupBridge";
import { DEFAULT_DB_PATH, getSession, openDb, updateSession } from "../sessions";

/** The whole message must be the command: a mention of it mid-sentence is text. */
export const RENAME_COMMAND = /^\/rename(?:\s+([\s\S]+))?$/;
const MAX_TITLE_BYTES = 200;

export interface RenameCommandPlan {
  /** The deferred rename → group-subject → confirm flow (behind the cursor). */
  after: () => Promise<void>;
}

/** Recognize the operator's `/rename` command in an accepted row. Returns null
 * when the message is not this command (wrong sender, wrong shape) and must
 * flow through the normal turn path. */
export function planRenameCommand(options: GroupBridgeOptions & { sessionsDbPath?: string }, row: PendingRow, message: Inbound): RenameCommandPlan | null {
  const log = options.log ?? (() => {});
  const match = RENAME_COMMAND.exec(message.text.trim());
  if (!match) return null;
  const binding = options.inbox.bindingFor("whatsapp", row.account, row.thread);
  if (!binding || !binding.allowedSenders.includes(message.sender)) {
    log("channel.rename_command.denied", { seq: row.seq, thread: row.thread, sender: message.sender });
    return null;
  }
  const title = (match[1] ?? "").trim();
  const after = async (): Promise<void> => {
    const sender = options.senderFor(row.account);
    const quoted = { id: message.messageId, remoteJid: row.thread, ...(message.sender ? { participant: message.sender } : {}) };
    if (!title || Buffer.byteLength(title) > MAX_TITLE_BYTES) {
      log("channel.rename_command.rejected", { seq: row.seq, reason: "empty_or_oversized_title" });
      await sender?.sendText({ number: row.thread, text: "Uso: /rename <nuevo título (máx 4 palabras recomendado)>", quoted }).catch(() => {});
      return;
    }
    try {
      const db = openDb(options.sessionsDbPath ?? process.env.MINITUI_DB_PATH ?? DEFAULT_DB_PATH);
      try {
        if (!getSession(db, row.session)) {
          log("channel.rename_command.failed", { seq: row.seq, session: row.session, error: "unknown session" });
          await sender?.sendText({ number: row.thread, text: `(no encuentro la sesión ${row.session} para renombrarla)`, quoted }).catch(() => {});
          return;
        }
        updateSession(db, row.session, { title });
      } finally {
        db.close();
      }
      log("channel.rename_command.renamed", { seq: row.seq, session: row.session, title });
      // A bound group wears the session's name: rename its subject too, and say
      // so honestly when the API refuses — the session itself is already renamed.
      let groupNote = "";
      if (row.thread.endsWith("@g.us")) {
        const account = options.accountFor(row.account);
        if (!account) {
          groupNote = " (la cuenta no tiene instancia configurada: el grupo no se renombró)";
        } else {
          const result = await setGroupSubject(options.baseUrl, account.instance, account.token, row.thread, title, { timeoutMs: options.timeoutMs });
          if (!result.ok) {
            log("channel.rename_command.group_failed", { seq: row.seq, groupJid: row.thread, error: result.error.slice(0, 200) });
            groupNote = ` (no pude renombrar el grupo: ${result.error.slice(0, 80)})`;
          }
        }
      }
      await sender?.sendText({ number: row.thread, text: `Sesión renombrada a "${title}".${groupNote}`, quoted });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log("channel.rename_command.failed", { seq: row.seq, session: row.session, error: reason.slice(0, 200) });
      await sender?.sendText({ number: row.thread, text: `(no pude renombrar la sesión: ${reason.slice(0, 120)})`, quoted }).catch(() => {});
    }
  };
  return { after };
}
