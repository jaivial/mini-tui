/**
 * Group-session bridge (WA-5, Jaime's multichat spec): every new session is a
 * NEW WhatsApp group where the operator talks to himself with the bot. The
 * session's model proposes it by ending a reply with one machine directive:
 *
 *     [[mini-newgroup: <subject>]]
 *
 * The directive is data, never authority: deterministic bridge code validates
 * it against the account configuration and performs the whole flow, in the
 * deferred lane (behind the inbox cursor, like the queue bridge):
 *
 *   1. create the group on the account's own weai instance
 *      (POST /group/create/{instance}, participants = the requesting sender);
 *   2. set the static mascot frame as group photo (WhatsApp group photos are
 *      JPG — the animated pet lives in the web panel / stickers, not here);
 *   3. bind the new @g.us thread to a FRESH session id (`wa-<account>-<hex8>`,
 *      its own conversation, its own binding model, allowlist = the requester
 *      only, default mention policy) — one group id is one isolated session
 *      and never sees another group's context;
 *   4. confirm in the requesting thread with the group's jid.
 *
 * A failure at any step never blocks the chat reply: it is logged and, when
 * possible, reported honestly to the requesting thread by the caller's
 * confirmation hook.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ChannelInbox, type Inbound } from "./inbox";
import type { EvoSender } from "./evoSend";
import type { PendingRow } from "./consumer";

export const NEWGROUP_DIRECTIVE = /\[\[mini-newgroup:\s*([^\]]*)\]\]/g;
const MAX_SUBJECT_BYTES = 200;

export interface GroupBridgeOptions {
  /** The shared channel store: bindings are operator-grade durable state. */
  inbox: ChannelInbox;
  /** Per-account weai coordinates; the group is created on the OWNING
   * account's instance with its own token — never another identity's. */
  accountFor: (account: string) => { instance: string; token: string } | undefined;
  baseUrl: string;
  /** Static JPG frame for the group photo (WhatsApp rejects animated formats). */
  photoPath?: string;
  /** Session id prefix/source for fresh sessions (repo convention wa-<account>-<hex8>). */
  newSessionId: (account: string) => string;
  /** Confirmation sender for the requesting thread (the row's own identity). */
  senderFor: (account: string) => EvoSender | undefined;
  timeoutMs?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface GroupPlan {
  /** The reply text with the directive stripped — chat stays conversational. */
  text: string;
  /** Deferred creation work; run behind the cursor, never before it. */
  after?: () => Promise<void>;
}

/** Strip the directive and, when present, return the deferred creation flow.
 * Malformed or empty subjects are dropped silently from the text (a directive
 * is never shown to the chat) and reported in the deferred result instead. */
export function planGroupCreation(options: GroupBridgeOptions, row: PendingRow, message: Inbound, replyText: string): GroupPlan {
  const log = options.log ?? (() => {});
  const chunks: string[] = [];
  let last = 0;
  let subject: string | null = null;
  for (const match of replyText.matchAll(NEWGROUP_DIRECTIVE)) {
    chunks.push(replyText.slice(last, match.index));
    last = match.index + match[0].length;
    const value = (match[1] ?? "").trim();
    if (value && Buffer.byteLength(value) <= MAX_SUBJECT_BYTES) subject = value;
  }
  if (subject === null && chunks.join("") === replyText) return { text: replyText };
  chunks.push(replyText.slice(last));
  const text = chunks.join("").replace(/\n{3,}/g, "\n\n").trim();

  const after = async (): Promise<void> => {
    if (!subject) {
      log("channel.group.rejected", { seq: row.seq, reason: "empty_or_oversized_subject" });
      return;
    }
    try {
      const created = await createBoundGroup(options, row, message, subject);
      log("channel.group.created", { seq: row.seq, account: row.account, groupJid: created.groupJid, session: created.session, subject });
      const sender = options.senderFor(row.account);
      if (sender) {
        await sender.sendText({
          number: row.thread,
          text: `Grupo "${subject}" creado con sesión nueva y aislada (${created.session}). Escríbeme allí mencionándome para hablar en ese hilo.`,
          quoted: { id: message.messageId, remoteJid: row.thread, participant: message.sender },
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log("channel.group.failed", { seq: row.seq, account: row.account, error: reason.slice(0, 200) });
      const sender = options.senderFor(row.account);
      if (sender) {
        await sender.sendText({
          number: row.thread,
          text: `(no pude crear el grupo "${subject}": ${reason.slice(0, 120)})`,
          quoted: { id: message.messageId, remoteJid: row.thread, participant: message.sender },
        }).catch(() => {});
      }
    }
  };
  return { text, after };
}

interface CreatedGroup {
  groupJid: string;
  session: string;
}

/** weai group call: the fork serves one path per channel per instance; the
 * instance apikey authenticates the identity that will own the group. */
async function callGroupApi(options: GroupBridgeOptions, instance: string, token: string, path: string, body: unknown, query = ""): Promise<{ status: number; json: any; error: string }> {
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl.replace(/\/+$/, "")}${path}/${encodeURIComponent(instance)}${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
  } catch (error) {
    return { status: 0, json: null, error: error instanceof Error ? error.message : String(error) };
  }
  let json: any = null;
  let error = "";
  try { json = await response.json(); } catch { error = `non-JSON response (${response.status})`; }
  return { status: response.status, json, error };
}

/** The created group's jid, wherever the fork put it in the response. */
function findGroupJid(value: unknown, depth = 0): string | null {
  if (typeof value === "string") return /@g\.us$/.test(value) ? value : null;
  if (depth > 6 || value === null || typeof value !== "object") return null;
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = findGroupJid(item, depth + 1);
    if (found) return found;
  }
  return null;
}

async function createBoundGroup(options: GroupBridgeOptions, row: PendingRow, message: Inbound, subject: string): Promise<CreatedGroup> {
  const account = options.accountFor(row.account);
  if (!account) throw new Error(`account ${row.account} has no instance configured`);
  const created = await callGroupApi(options, account.instance, account.token, "/group/create", {
    subject,
    description: `mini session ${new Date().toISOString()}`,
    // The requester is the (single) human participant; the account itself joins
    // as creator. Groups without the requester would be unreachable to them.
    participants: [message.sender],
  });
  if (created.status !== 200 && created.status !== 201) throw new Error(`group create failed: ${created.error || `status ${created.status}`}`);
  const groupJid = findGroupJid(created.json);
  if (!groupJid) throw new Error("group create response carried no @g.us jid");

  // Static mascot frame. The fork takes JSON {image: <base64>} with the target
  // groupJid in the query. A missing photo file is a cosmetic failure: the
  // group is still created and bound, and the reason is logged by the caller.
  const photoPath = options.photoPath ?? join(import.meta.dir, "assets", "group-mascot.jpg");
  if (existsSync(photoPath)) {
    try {
      const image = readFileSync(photoPath).toString("base64");
      const photo = await callGroupApi(options, account.instance, account.token, "/group/updateGroupPicture", { image }, `?groupJid=${encodeURIComponent(groupJid)}`);
      if (photo.status !== 200 && photo.status !== 201) throw new Error(`status ${photo.status}: ${photo.error.slice(0, 120)}`);
    } catch (error) {
      options.log?.("channel.group.photo_failed", { groupJid, error: error instanceof Error ? error.message : String(error) });
    }
  } else {
    options.log?.("channel.group.photo_missing", { groupJid, photoPath });
  }

  // The binding IS the isolation: fresh session id, its own allowlist, default
  // (mention-gated) policy, and the consumer resolves the binding model per
  // turn — the new group starts on the operator/default model until changed.
  const session = options.newSessionId(row.account);
  options.inbox.bind({
    channel: "whatsapp",
    account: row.account,
    thread: groupJid,
    session,
    project: row.project,
    allowedSenders: [message.sender],
    policy: "mentions",
    model: "",
  });
  return { groupJid, session };
}
