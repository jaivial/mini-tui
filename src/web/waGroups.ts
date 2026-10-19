/**
 * One WhatsApp group per web session (best effort). When a chat is created in
 * the web UI and the WhatsApp bridge is configured, a group is created on the
 * account's instance with the operator's own number as the ONLY participant
 * and bound to that same session id; deleting the session leaves the group
 * and drops the binding. Nothing here can fail the session path: every entry
 * point swallows errors and logs `wa.group.*`.
 *
 * Only groups bound to the session by this module are ever touched.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { ChannelInbox, type Binding } from "../channels/inbox";
import { parseConsumerAccounts } from "../channels/accounts";
import { avatarFileFor } from "../channels/groupAvatar";
import { setGroupPicture } from "../channels/groupPicture";
import { setGroupSubject } from "../channels/groupBridge";
import { log } from "./log";

const PROJECT = "wa-assistant";
const MAX_SUBJECT = 100;

interface Ctx { inbox: ChannelInbox; account: string; instance: string; token: string; base: string; owner: string }

let inboxSingleton: ChannelInbox | null | undefined;
function inbox(): ChannelInbox | null {
  if (inboxSingleton !== undefined) return inboxSingleton;
  try {
    inboxSingleton = new ChannelInbox(process.env.EVO_INBOX_DB ?? join(homedir(), ".local/share/mini-tui/channels.sqlite"));
  } catch {
    inboxSingleton = null;
  }
  return inboxSingleton;
}

/** The operator's own phone number: MINITUI_WA_GROUP_OWNER, else the phone-form
 * jid every existing binding of the account allows. Never anyone else. */
function ownerFor(store: ChannelInbox, account: string): string | undefined {
  const env = (process.env.MINITUI_WA_GROUP_OWNER ?? "").replace(/\D/g, "");
  if (env) return env;
  for (const b of store.listBindings(account)) {
    for (const s of b.allowedSenders) {
      const m = s.match(/^(\d{7,15})@s\.whatsapp\.net$/);
      if (m) return m[1];
    }
  }
  return undefined;
}

function context(): Ctx | null {
  const base = (process.env.EVO_API_URL ?? "").replace(/\/+$/, "");
  const store = inbox();
  if (!base || !store) return null;
  const acc = parseConsumerAccounts()[0];
  if (!acc?.instance || !acc.token) return null;
  const owner = ownerFor(store, acc.account);
  if (!owner) return null;
  return { inbox: store, account: acc.account, instance: acc.instance, token: acc.token, base, owner };
}

async function evo(ctx: Ctx, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${ctx.base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", apikey: ctx.token },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(25_000),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

const groupBindings = (ctx: Ctx, session: string): Binding[] =>
  ctx.inbox.listBindings(ctx.account).filter((b) => b.channel === "whatsapp" && b.session === session && b.thread.endsWith("@g.us"));

const subjectOf = (title: string): string => {
  const clean = title.replace(/\s+/g, " ").trim() || "Chat";
  return Array.from(clean).slice(0, MAX_SUBJECT).join("");
};

/** Sessions the WhatsApp bridge itself owns (wa-<account>-<hex>) keep their own groups. */
const bridgeOwned = (session: string): boolean => session.startsWith("wa-");

const inflight = new Map<string, Promise<void>>();

export function ensureGroupForSession(session: string, title: string): void {
  if (bridgeOwned(session)) return;
  if (inflight.has(session)) return;
  const run = (async () => {
    const ctx = context();
    if (!ctx) return;
    if (groupBindings(ctx, session).length) return;
    const state = await evo(ctx, "GET", `/instance/connectionState/${encodeURIComponent(ctx.instance)}`);
    const raw = String(state.json?.instance?.state ?? state.json?.state ?? "");
    if (state.status !== 200 || !/^(open|connected)$/i.test(raw)) return; // WhatsApp not connected: nothing to do
    const created = await evo(ctx, "POST", `/group/create/${encodeURIComponent(ctx.instance)}`, { subject: subjectOf(title), participants: [ctx.owner] });
    const j = created.json;
    const jid: string | undefined = j?.id ?? j?.jid ?? j?.groupJid ?? j?.wid ?? (Array.isArray(j) ? j[0]?.id : undefined);
    if (created.status >= 300 || !jid || !String(jid).endsWith("@g.us")) throw new Error(`group create failed (status ${created.status})`);
    // Bind first: from here the session owns the group, even if the photo fails.
    ctx.inbox.bind({
      channel: "whatsapp", account: ctx.account, thread: jid, session, project: PROJECT,
      allowedSenders: [ctx.owner, `${ctx.owner}@s.whatsapp.net`], policy: "all", model: "",
    });
    log("wa.group.created", { session, group: jid });
    const avatar = avatarFileFor(session);
    if (avatar) {
      const photo = await setGroupPicture(ctx.base, ctx.instance, ctx.token, jid, avatar).catch(() => null);
      if (!photo?.ok) log("wa.group.photo-failed", { session });
    }
  })().catch((error) => log("wa.group.error", { session, op: "create", error: error instanceof Error ? error.message : String(error) }))
    .finally(() => { inflight.delete(session); });
  inflight.set(session, run);
}

export function dropGroupForSession(session: string): void {
  if (bridgeOwned(session)) return;
  void (async () => {
    await inflight.get(session); // a create still running is finished first, then undone
    const ctx = context();
    if (!ctx) return;
    for (const b of groupBindings(ctx, session)) {
      let left = false;
      try {
        const r = await evo(ctx, "DELETE", `/group/leaveGroup/${encodeURIComponent(ctx.instance)}?groupJid=${encodeURIComponent(b.thread)}`);
        left = r.status < 300;
        if (!left) log("wa.group.leave-refused", { session, status: r.status });
      } catch (error) {
        log("wa.group.error", { session, op: "leave", error: error instanceof Error ? error.message : String(error) });
      }
      ctx.inbox.unbind("whatsapp", ctx.account, b.thread);
      log("wa.group.dropped", { session, group: b.thread, left });
    }
  })().catch((error) => log("wa.group.error", { session, op: "drop", error: error instanceof Error ? error.message : String(error) }));
}

export function renameGroupForSession(session: string, title: string): void {
  if (bridgeOwned(session)) return;
  void (async () => {
    await inflight.get(session);
    const ctx = context();
    if (!ctx) return;
    for (const b of groupBindings(ctx, session)) {
      const r = await setGroupSubject(ctx.base, ctx.instance, ctx.token, b.thread, subjectOf(title));
      if (!r.ok) log("wa.group.rename-failed", { session, status: r.status });
    }
  })().catch(() => {});
}
