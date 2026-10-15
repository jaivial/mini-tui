/**
 * Operator chat command (v4-H): `/newsession <subject>` typed in a bound
 * thread starts a brand-new isolated session in ONE deterministic step —
 * fresh WhatsApp group, session avatar as the group photo, fresh binding —
 * with NO model turn and NO prompt-injection surface:
 *
 *   - Authority is operator-grade configuration, never message content: the
 *     command only fires for a sender already on the thread's own allowlist
 *     (the exact same list the accept boundary enforces). Anyone else's
 *     "/newsession …" is plain text for the normal turn.
 *   - The command bypasses the group mention gate on purpose (an explicit
 *     operator command is more specific than a mention policy), but it never
 *     grants the sender anything new: the created group's allowlist starts
 *     with exactly the requester, mention-gated like every other session.
 *   - The requesting thread stays intact: it only receives the confirmation
 *     (or an honest failure note) as a quoted reply.
 *   - Handled rows are acknowledged BEFORE the deferred creation runs: a
 *     crash mid-creation replays nothing (one command, at most one group —
 *     an operator re-runs the command instead of receiving a duplicate).
 */

import type { Inbound } from "./inbox";
import type { PendingRow } from "./consumer";
import { createBoundGroupFor, type CreatedGroup, type GroupBridgeOptions } from "./groupBridge";

/** The whole message must be the command: a mention of it mid-sentence is text. */
export const NEWSESSION_COMMAND = /^\/newsession(?:\s+([\s\S]+))?$/;
const MAX_SUBJECT_BYTES = 200;

export interface SessionCommandPlan {
  /** The deferred create → avatar → bind → confirm flow (behind the cursor). */
  after: () => Promise<void>;
}

/** Recognize the operator's `/newsession` command in an accepted row. Returns
 * null when the message is not this command (wrong sender, wrong shape) and
 * must flow through the normal turn path. */
export function planSessionCommand(options: GroupBridgeOptions, row: PendingRow, message: Inbound): SessionCommandPlan | null {
  const log = options.log ?? (() => {});
  const match = NEWSESSION_COMMAND.exec(message.text.trim());
  if (!match) return null;
  const binding = options.inbox.bindingFor("whatsapp", row.account, row.thread);
  if (!binding || !binding.allowedSenders.includes(message.sender)) {
    log("channel.session_command.denied", { seq: row.seq, thread: row.thread, sender: message.sender });
    return null;
  }
  const subject = (match[1] ?? "").trim();
  const after = async (): Promise<void> => {
    const sender = options.senderFor(row.account);
    const quoted = { id: message.messageId, remoteJid: row.thread, ...(message.sender ? { participant: message.sender } : {}) };
    if (!subject || Buffer.byteLength(subject) > MAX_SUBJECT_BYTES) {
      log("channel.session_command.rejected", { seq: row.seq, reason: "empty_or_oversized_subject" });
      await sender?.sendText({ number: row.thread, text: 'Uso: /newsession <nombre corto para la nueva sesión>', quoted }).catch(() => {});
      return;
    }
    try {
      const created: CreatedGroup = await createBoundGroupFor(options, {
        account: row.account,
        requesterJid: message.sender,
        requesterThread: row.thread,
        subject,
        project: row.project,
      });
      log("channel.session_command.created", { seq: row.seq, account: row.account, groupJid: created.groupJid, session: created.session, subject });
      await sender?.sendText({
        number: row.thread,
        text: `Grupo "${subject}" creado con sesión nueva y aislada (${created.session}). Escríbeme allí mencionándome para hablar en ese hilo.`,
        quoted,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log("channel.session_command.failed", { seq: row.seq, account: row.account, error: reason.slice(0, 200) });
      await sender?.sendText({
        number: row.thread,
        text: `(no pude crear el grupo "${subject}": ${reason.slice(0, 120)})`,
        quoted,
      }).catch(() => {});
    }
  };
  return { after };
}
