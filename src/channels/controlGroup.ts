/**
 * Control group on connect (v4-H): when the account's WhatsApp instance comes
 * online, the account must always own at least ONE bound command channel. A
 * watcher polls the instance's connection state (loopback, same weai API the
 * web panel reads) and, on the transition to connected, ensures a control
 * group exists — the same create → avatar → bind machinery as `/newsession`:
 *
 *   - bound to a fresh session id, allowlist = every trusted jid form of the
 *     account owner (EVO_ACCOUNTS `jid`), policy "all" (no mention needed);
 *   - announced with a message in the group itself;
 *   - IDEMPOTENT across re-connects: a durable marker row (channel_control_groups)
 *     records the account's control group forever. The watcher creates at most
 *     one control group per account, ever — a re-connect, a service restart or
 *     a later unbind never duplicates it. Delete the marker row to allow one
 *     new control group (operator action, via bindingsCli/SQL).
 *
 * Creation failures are logged and retried on the next poll while still
 * connected; the marker is written only after the group is created AND bound.
 */

import { ChannelInbox } from "./inbox";
import { createBoundGroupFor, type GroupBridgeOptions } from "./groupBridge";

/** Control-group subject (visible group name). */
export const CONTROL_GROUP_SUBJECT = "Control mini";

/** Durable idempotency marker: one control group per account, ever. */
export interface ControlGroupMarker {
  account: string;
  groupJid: string;
  createdAt: number;
}

/** Ensure the marker table exists on the shared channel store. */
export function ensureControlGroupTable(inbox: ChannelInbox): void {
  inbox.db.exec(`CREATE TABLE IF NOT EXISTS channel_control_groups(account TEXT PRIMARY KEY,group_jid TEXT NOT NULL,created_at INTEGER NOT NULL)`);
}

export function controlGroupFor(inbox: ChannelInbox, account: string): ControlGroupMarker | null {
  return (inbox.db.query(`SELECT account,group_jid AS groupJid,created_at AS createdAt FROM channel_control_groups WHERE account=?1`).get(account) as ControlGroupMarker | undefined) ?? null;
}

export interface ControlGroupOptions {
  /** The shared channel store: markers and the new binding. */
  inbox: ChannelInbox;
  /** One entry per account (subset of GroupBridgeOptions' accounts): the
   * instance to poll and the owner's trusted jid forms (the allowlist). */
  accounts: Array<{ account: string; instance: string; token: string; ownerJids: string[] }>;
  /** The group bridge configuration (create → avatar → bind). */
  bridge: GroupBridgeOptions;
  /** weai base URL for the connection-state poll. */
  baseUrl: string;
  pollMs?: number;
  timeoutMs?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/** instance connection state, as weai answers it (flat or nested). */
async function connectionState(options: ControlGroupOptions, instance: string, token: string): Promise<string | null> {
  try {
    const response = await fetch(`${options.baseUrl.replace(/\/+$/, "")}/instance/connectionState/${encodeURIComponent(instance)}`, {
      headers: { apikey: token },
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    if (response.status !== 200) return null;
    const data = (await response.json()) as Record<string, unknown>;
    const read = (value: unknown): string | null => (typeof value === "string" ? value.toLowerCase() : null);
    const nested = data.instance;
    return read(data.state) ?? read(data.connectionStatus) ?? (nested && typeof nested === "object" ? (read((nested as Record<string, unknown>).state) ?? read((nested as Record<string, unknown>).connectionStatus)) : null);
  } catch {
    return null;
  }
}

/** Ensure ONE control group for the account: marker (never duplicate) and an
 * existing @g.us binding both suppress creation. Returns the group jid or null. */
export async function ensureControlGroup(options: ControlGroupOptions, entry: { account: string; instance: string; token: string; ownerJids: string[] }): Promise<string | null> {
  const log = options.log ?? (() => {});
  ensureControlGroupTable(options.inbox);
  const marker = controlGroupFor(options.inbox, entry.account);
  if (marker) {
    log("channel.control_group.exists", { account: entry.account, groupJid: marker.groupJid });
    return null;
  }
  const hasGroupBinding = options.inbox.listBindings(entry.account).some((binding) => binding.thread.endsWith("@g.us"));
  if (hasGroupBinding) {
    // The account already owns a command channel: none is created (and no
    // marker is written — the operator may still unbind it and expect one).
    log("channel.control_group.has_binding", { account: entry.account });
    return null;
  }
  const ownerJids = entry.ownerJids.filter((jid) => jid);
  if (!ownerJids.length) {
    log("channel.control_group.skipped", { account: entry.account, reason: "no owner jids configured" });
    return null;
  }
  // The requester's FIRST jid form is what the allowlist is anchored on; the
  // bridge adds every resolved form itself (policy "all", fresh session).
  const created = await createBoundGroupFor(options.bridge, {
    account: entry.account,
    requesterJid: ownerJids[0]!,
    requesterThread: ownerJids[0]!,
    subject: CONTROL_GROUP_SUBJECT,
  });
  options.inbox.db.query(`INSERT INTO channel_control_groups(account,group_jid,created_at) VALUES(?1,?2,?3)`).run(entry.account, created.groupJid, Date.now());
  log("channel.control_group.created", { account: entry.account, groupJid: created.groupJid, session: created.session });
  return created.groupJid;
}

/** The watcher: poll every account's connection state; on the transition to
 * connected, ensure the control group and announce it in the group itself. */
export function startControlGroupWatcher(options: ControlGroupOptions): { stop: () => void; done: Promise<void> } {
  const log = options.log ?? (() => {});
  const pollMs = options.pollMs ?? 30_000;
  const states = new Map<string, string | null>();
  let stopped = false;
  let wake: (() => void) | null = null;
  const done = (async () => {
    ensureControlGroupTable(options.inbox);
    log("channel.control_group.watcher_start", { accounts: options.accounts.map((a) => a.account) });
    while (!stopped) {
      for (const entry of options.accounts) {
        const previous = states.get(entry.account) ?? null;
        const state = await connectionState(options, entry.instance, entry.token);
        states.set(entry.account, state);
        // Fire on the disconnected → connected transition (and on a first
        // observation that is already connected, e.g. watcher after connect).
        if (state !== "open") continue;
        if (previous === "open") continue;
        try {
          const groupJid = await ensureControlGroup(options, entry);
          if (groupJid && options.bridge.senderFor(entry.account)) {
            await options.bridge.senderFor(entry.account)!.sendText({
              number: groupJid,
              text: "Grupo de control listo: escribe aquí tus comandos y te respondo directamente, sin necesidad de mencionarme.",
            });
          }
        } catch (error) {
          log("channel.control_group.failed", { account: entry.account, error: error instanceof Error ? error.message : String(error) });
        }
      }
      await Promise.race([sleep(pollMs), new Promise<void>((r) => (wake = r))]);
    }
    log("channel.control_group.watcher_stop", {});
  })();
  return { stop: () => { stopped = true; wake?.(); }, done };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
