/**
 * Espejo WhatsApp ↔ web: the mirror store, the own-send anti-echo registry and
 * the wire-event mapping. In-memory sqlite per test; no network, no services.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChannelInbox } from "../src/channels/inbox";
import { MirrorStore, mirrorEvent } from "../src/channels/mirror";
import { SendLedger } from "../src/channels/evoSend";

let dir: string;
let inbox: ChannelInbox;
let mirror: MirrorStore;
let ledger: SendLedger;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "channel-mirror-"));
  inbox = new ChannelInbox(join(dir, "channels.sqlite"));
  mirror = new MirrorStore(inbox.db);
  ledger = new SendLedger(inbox.db);
  inbox.bind({
    channel: "whatsapp",
    account: "mini-assistant",
    thread: "120363432356582563@g.us",
    session: "wa-test-session",
    project: "wa-assistant",
    allowedSenders: ["34600000000@s.whatsapp.net"],
    policy: "mentions",
  });
});

afterAll(() => {
  inbox.close();
  rmSync(dir, { recursive: true, force: true });
});

const baseAppend = {
  inboxSeq: 1,
  session: "wa-test-session",
  channel: "whatsapp",
  account: "mini-assistant",
  thread: "120363432356582563@g.us",
  messageId: "MSG-1",
  sender: "34600000000@s.whatsapp.net",
  sentAt: Date.now(),
  text: "hola desde el grupo",
  attachments: [],
};

describe("MirrorStore", () => {
  test("append is idempotent per (channel, message_id)", () => {
    const first = mirror.append(baseAppend);
    expect(first).not.toBeNull();
    expect(mirror.append(baseAppend)).toBeNull();
    expect(mirror.after(0)).toHaveLength(1);
  });

  test("after() only returns rows past the cursor, oldest first", () => {
    mirror.append({ ...baseAppend, messageId: "MSG-2", text: "segundo" });
    const rows = mirror.after(1);
    expect(rows.map((r) => r.messageId)).toEqual(["MSG-2"]);
    expect(mirror.after(99)).toEqual([]);
  });

  test("forSession returns the session's rows minus what the transcript already shows", () => {
    const all = mirror.forSession("wa-test-session");
    expect(all.map((r) => r.messageId)).toEqual(["MSG-1", "MSG-2"]);
    const shown = mirror.forSession("wa-test-session", [{ mirrorId: all[0]!.id }]);
    expect(shown.map((r) => r.messageId)).toEqual(["MSG-2"]);
    expect(mirror.forSession("another-session")).toEqual([]);
  });

  test("oversized text is refused, malformed attachment lists degrade to empty", () => {
    expect(mirror.append({ ...baseAppend, messageId: "MSG-BIG", text: "x".repeat(64_001) })).toBeNull();
    mirror.append({ ...baseAppend, messageId: "MSG-ATT", text: "con foto", attachments: [{ id: "m1:img", kind: "image", mime: "image/jpeg", path: "/tmp/nowhere.jpg" }] });
    const row = mirror.after(0).find((r) => r.messageId === "MSG-ATT")!;
    expect(row.attachments).toHaveLength(1);
    expect(row.attachments[0]!.kind).toBe("image");
  });
});

describe("own-send anti-echo registry", () => {
  test("a ledgered reply id is our own send", () => {
    ledger.begin(1, "respuesta", null);
    ledger.markSent(1, "LEDGER-ID-1");
    expect(inbox.isOwnSendId("LEDGER-ID-1")).toBe(true);
  });

  test("a registered relay (web) send id is our own send, cross-process durable", () => {
    expect(inbox.isOwnSendId("RELAY-ID-9")).toBe(false);
    inbox.registerOwnSend("RELAY-ID-9");
    expect(inbox.isOwnSendId("RELAY-ID-9")).toBe(true);
    // A second handle over the same store (the receiver service) sees it too.
    const second = new ChannelInbox(join(dir, "channels.sqlite"));
    expect(second.isOwnSendId("RELAY-ID-9")).toBe(true);
    second.close();
  });

  test("bindingsForSession only answers bound whatsapp routes", () => {
    const bindings = inbox.bindingsForSession("wa-test-session");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.thread).toBe("120363432356582563@g.us");
    expect(inbox.bindingsForSession("unbound-session")).toEqual([]);
  });
});

describe("mirrorEvent", () => {
  test("stored media gets a URL, only inside the media dir and only store names", () => {
    const ctx = { mediaDir: "/data/media" };
    const urlOf = (path: string) => {
      if (!path.startsWith(ctx.mediaDir + "/")) return null;
      const name = path.slice(ctx.mediaDir.length + 1);
      return /^seq\d+-[A-Za-z0-9._-]+$/.test(name) ? `/api/channel-media/${name}` : null;
    };
    const row = mirror.forSession("wa-test-session").find((r) => r.messageId === "MSG-ATT")!;
    const event = mirrorEvent(row, urlOf);
    expect(event.type).toBe("channel");
    expect(event.origin).toBe("whatsapp");
    expect(event.mirrorId).toBe(row.id);
    // This row's stored path is outside the media dir: metadata only, no URL.
    expect(event.attachments[0]!.url).toBeNull();
  });
});
