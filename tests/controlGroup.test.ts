/**
 * Control group on connect (v4-H): ensureControlGroup creates exactly one
 * bound group per account (policy "all", owner allowlist), is idempotent via
 * the durable marker (never duplicates on re-invocation) and skips when the
 * account already owns a @g.us binding. groupBridge binds bot-created groups
 * with policy "all" and every trusted jid form of the requester.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { ChannelInbox } from "../src/channels/inbox";
import { createBoundGroupFor, type GroupBridgeOptions } from "../src/channels/groupBridge";
import { CONTROL_GROUP_SUBJECT, controlGroupFor, ensureControlGroup, ensureControlGroupTable, type ControlGroupOptions } from "../src/channels/controlGroup";

const LID = "242554100576489@lid";
const PHONE = "34692747052@s.whatsapp.net";
const ACCOUNT = "evo";

let dir: string;
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function freshInbox(): ChannelInbox {
  dir = mkdtempSync(join(tmpdir(), "control-group-"));
  return new ChannelInbox(join(dir, "channels.sqlite"));
}

function fakeBridgeOptions(inbox: ChannelInbox): GroupBridgeOptions {
  return {
    inbox,
    accountFor: () => ({ instance: "mini-assistant", token: "x".repeat(40) }),
    baseUrl: "http://127.0.0.1:1",
    newSessionId: (account) => `wa-${account}-test`,
    senderFor: () => undefined,
    resolveParticipant: (jid) => (jid.endsWith("@lid") ? PHONE : jid),
    timeoutMs: 1000,
    log: () => {},
  };
}

/** Stub the weai group-create + connection-state HTTP surface. */
function stubFetch(urls: string[]): () => void {
  const original = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = async (input: any) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/group/create/")) {
      return new Response(JSON.stringify({ instanceKey: { groupJid: "120363999999999999@g.us" } }), { status: 200 });
    }
    if (url.includes("/instance/connectionState/")) {
      return new Response(JSON.stringify({ instance: { state: "open" } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  return () => { (globalThis as any).fetch = original; };
}

describe("createBoundGroupFor binding", () => {
  test("binds the owner with every jid form and policy all (no mention needed)", async () => {
    const inbox = freshInbox();
    const restore = stubFetch([]);
    try {
      await createBoundGroupFor(fakeBridgeOptions(inbox), {
        account: ACCOUNT,
        requesterJid: LID,
        requesterThread: LID,
        subject: "QA",
      });
      const binding = inbox.bindingFor("whatsapp", ACCOUNT, "120363999999999999@g.us");
      expect(binding).not.toBeNull();
      expect(binding!.policy).toBe("all");
      expect(binding!.allowedSenders).toContain(LID);
      expect(binding!.allowedSenders).toContain(PHONE);
    } finally {
      restore();
    }
  });
});

describe("ensureControlGroup", () => {
  test("creates one group, binds policy all, records the marker, and never duplicates", async () => {
    const inbox = freshInbox();
    const urls: string[] = [];
    const restore = stubFetch(urls);
    try {
      ensureControlGroupTable(inbox);
      const options: ControlGroupOptions = {
        inbox,
        baseUrl: "http://127.0.0.1:1",
        bridge: fakeBridgeOptions(inbox),
        accounts: [{ account: ACCOUNT, instance: "mini-assistant", token: "t", ownerJids: [PHONE, LID] }],
        log: () => {},
      };
      const first = await ensureControlGroup(options, options.accounts[0]!);
      expect(first).toBe("120363999999999999@g.us");
      const binding = inbox.bindingFor("whatsapp", ACCOUNT, first!);
      expect(binding!.policy).toBe("all");
      expect(binding!.allowedSenders).toContain(PHONE);
      expect(controlGroupFor(inbox, ACCOUNT)?.groupJid).toBe(first);

      const calls = urls.filter((u) => u.includes("/group/create/")).length;
      expect(calls).toBe(1);

      // Re-connect, restart, re-invoke: the marker suppresses a second group.
      const second = await ensureControlGroup(options, options.accounts[0]!);
      expect(second).toBeNull();
      expect(urls.filter((u) => u.includes("/group/create/")).length).toBe(1);
    } finally {
      restore();
    }
  });

  test("skips when the account already owns a group binding (no marker written)", async () => {
    const inbox = freshInbox();
    const urls: string[] = [];
    const restore = stubFetch(urls);
    try {
      ensureControlGroupTable(inbox);
      inbox.bind({ channel: "whatsapp", account: ACCOUNT, thread: "120363411180584976@g.us", session: "wa-evo-x", project: "p", allowedSenders: [PHONE], policy: "all" });
      const options: ControlGroupOptions = {
        inbox,
        baseUrl: "http://127.0.0.1:1",
        bridge: fakeBridgeOptions(inbox),
        accounts: [{ account: ACCOUNT, instance: "mini-assistant", token: "t", ownerJids: [PHONE] }],
        log: () => {},
      };
      expect(await ensureControlGroup(options, options.accounts[0]!)).toBeNull();
      expect(controlGroupFor(inbox, ACCOUNT)).toBeNull();
      expect(urls.filter((u) => u.includes("/group/create/")).length).toBe(0);
    } finally {
      restore();
    }
  });
});
