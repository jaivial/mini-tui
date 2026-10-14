/**
 * WA-2 channel layer: consumer loop, session bridge recovery and the outbound
 * Evo sender. Everything runs against a throwaway inbox database; no agent
 * process and no network are involved (the sender is tested against a local
 * Bun server that only answers on loopback, mirroring production).
 */
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChannelInbox, type Inbound } from "../src/channels/inbox";
import { SessionBridge, type LiveSessionLike } from "../src/channels/sessionBridge";
import { EvoSender, EvoSendError } from "../src/channels/evoSender";
import { startChannelConsumer } from "../src/channels/consumer";
import { Database } from "bun:sqlite";

const SANDBOX = mkdtempSync(join(tmpdir(), "mini-tui-channels-"));
const DB_FILES = ["probe.sqlite", "probe.sqlite-wal", "probe.sqlite-shm"];
afterEach(() => {
  for (const name of DB_FILES) rmSync(join(SANDBOX, name), { force: true });
});

const inbound = (text: string, messageId = "m1"): Inbound => ({
  channel: "whatsapp",
  account: "acct",
  thread: "34600@s.whatsapp.net",
  messageId,
  sender: "34600@s.whatsapp.net",
  sentAt: Date.now(),
  text,
  attachments: [],
});

function makeInbox(): ChannelInbox {
  const inbox = new ChannelInbox(join(SANDBOX, "probe.sqlite"));
  inbox.bind({ channel: "whatsapp", account: "acct", thread: "34600@s.whatsapp.net", session: "sess-1", project: "p", allowedSenders: ["34600@s.whatsapp.net"] });
  return inbox;
}

const inboxRow = (inbox: ChannelInbox, seq: number) =>
  inbox.db.query("SELECT seq,payload,session,project FROM channel_inbox WHERE seq=?1").get(seq) as { seq: number; payload: string; session: string; project: string };

describe("SessionBridge recovery", () => {
  const config = { cwd: SANDBOX, errorNotice: "ERR", attachmentNotice: "ATT" };

  test("first message creates the session with the binding id; second message continues it", async () => {
    const db = new Database(":memory:");
    const created: string[] = [];
    const sent: Array<[string, string]> = [];
    const sessions = new Map<string, LiveSessionLike>();
    const bridge = new SessionBridge(db, config, {
      get: async (id) => sessions.get(id),
      create: async (init) => {
        created.push(init.id);
        sessions.set(init.id, { id: init.id, status: "done", events: [{ type: "task", text: init.prompt }, { type: "assistant", text: `answer to ${init.prompt}` }] });
      },
      send: async (id, prompt) => {
        sent.push([id, prompt]);
        sessions.set(id, { id, status: "running", events: [{ type: "task", text: prompt }] });
      },
    });
    const inbox = makeInbox();
    const a = inbox.accept(inbound("hola", "a"));
    expect(await bridge.deliver({ ...inboxRow(inbox, a.seq), session: "sess-1" })).toBe("answer to hola");
    expect(created).toEqual(["sess-1"]);
    const b = inbox.accept(inbound("otra", "b"));
    const second = bridge.deliver({ ...inboxRow(inbox, b.seq), session: "sess-1" });
    setTimeout(() => sessions.set("sess-1", { id: "sess-1", status: "done", events: [{ type: "task", text: "otra" }, { type: "assistant", text: "answer to otra" }] }), 100);
    expect(await second).toBe("answer to otra");
    expect(sent).toEqual([["sess-1", "otra"]]); // no second create, the same session continues
  });

  test("a complete turn is never repeated", async () => {
    const db = new Database(":memory:");
    let createCount = 0;
    const sessions = new Map<string, LiveSessionLike>();
    const bridge = new SessionBridge(db, config, {
      get: async (id) => sessions.get(id),
      create: async (init) => {
        createCount++;
        sessions.set(init.id, { id: init.id, status: "done", events: [{ type: "task", text: init.prompt }, { type: "assistant", text: "the reply" }] });
      },
      send: async () => {
        throw new Error("must not send");
      },
    });
    const inbox = makeInbox();
    const a = inbox.accept(inbound("hola"));
    expect(await bridge.deliver({ ...inboxRow(inbox, a.seq), session: "sess-1" })).toBe("the reply");
    expect(await bridge.deliver({ ...inboxRow(inbox, a.seq), session: "sess-1" })).toBe("the reply");
    expect(createCount).toBe(1);
  });

  test("starting + no delivery evidence + idle session: the prompt is handed over exactly once", async () => {
    const db = new Database(":memory:");
    const sessions = new Map<string, LiveSessionLike>([
      ["sess-1", { id: "sess-1", status: "running", events: [{ type: "task", text: "hola" }] }],
    ]);
    let calls = 0;
    const bridge = new SessionBridge(db, { ...config, turnTimeoutMs: 5_000 }, {
      get: async (id) => {
        calls++;
        // The very first look (the recovery evidence check) runs before the
        // session is visible; every later look reads the live map.
        return calls === 1 ? undefined : sessions.get(id);
      },
      create: async (init) => {
        sessions.set(init.id, { id: init.id, status: "running", events: [{ type: "task", text: init.prompt }] });
      },
      send: async () => {
        throw new Error("a delivered prompt must never be sent twice");
      },
    });
    const inbox = makeInbox();
    const a = inbox.accept(inbound("hola"));
    // Simulate the crash: reserve the turn, die before the session answers.
    db.query("INSERT INTO channel_turns(inbox_seq,session,status,reply,updated_at) VALUES(?1,'sess-1','starting',NULL,?2)").run(a.seq, Date.now());
    const pending = bridge.deliver({ ...inboxRow(inbox, a.seq), session: "sess-1" });
    // The turn is running; the loop waits. Stop the session to end the turn.
    setTimeout(() => sessions.set("sess-1", { id: "sess-1", status: "done", events: [{ type: "task", text: "hola" }, { type: "assistant", text: "late answer" }] }), 700);
    expect(await pending).toBe("late answer");
  });

  test("running turn recovery only waits, never re-prompts", async () => {
    const db = new Database(":memory:");
    const sessions = new Map<string, LiveSessionLike>([
      ["sess-1", { id: "sess-1", status: "running", events: [] }],
    ]);
    const bridge = new SessionBridge(db, { ...config, turnTimeoutMs: 5_000 }, {
      get: async (id) => sessions.get(id),
      create: async () => {
        throw new Error("must not create");
      },
      send: async () => {
        throw new Error("must not re-prompt a running turn");
      },
    });
    const inbox = makeInbox();
    const a = inbox.accept(inbound("hola"));
    db.query("INSERT INTO channel_turns(inbox_seq,session,status,reply,updated_at) VALUES(?1,'sess-1','running',NULL,?2)").run(a.seq, Date.now());
    const pending = bridge.deliver({ ...inboxRow(inbox, a.seq), session: "sess-1" });
    setTimeout(() => sessions.set("sess-1", { id: "sess-1", status: "done", events: [{ type: "assistant", text: "finally" }] }), 700);
    expect(await pending).toBe("finally");
  });

  test("a failed turn answers the error notice once and is consumed", async () => {
    const db = new Database(":memory:");
    const sessions = new Map<string, LiveSessionLike>();
    const bridge = new SessionBridge(db, config, {
      get: async (id) => sessions.get(id),
      create: async (init) => {
        sessions.set(init.id, { id: init.id, status: "error", events: [{ type: "task", text: init.prompt }] });
      },
      send: async () => {
        throw new Error("must not retry");
      },
    });
    const inbox = makeInbox();
    const a = inbox.accept(inbound("hola"));
    expect(await bridge.deliver({ ...inboxRow(inbox, a.seq), session: "sess-1" })).toBe("ERR");
    expect(await bridge.deliver({ ...inboxRow(inbox, a.seq), session: "sess-1" })).toBe("ERR"); // recorded, no retry
  });
});

describe("EvoSender at-most-once", () => {
  const origin = { thread: "34600@s.whatsapp.net", quoteId: "q1", sender: "34600@s.whatsapp.net", isGroup: false, text: "hola" };

  function senderFor(handler: (request: Request) => Response | Promise<Response>) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    const db = new Database(":memory:");
    const sender = new EvoSender(db, { baseUrl: `http://127.0.0.1:${server.port}`, instance: "inst", apiKey: "k" });
    return { server, db, sender };
  }

  test("a confirmed 201 marks the row sent; a repeat call never wires a second send", async () => {
    let posts = 0;
    const { server, sender } = senderFor(() => {
      posts++;
      return Response.json({ key: { id: "wamid.X" } }, { status: 201 });
    });
    try {
      expect(await sender.sendReply(1, origin, "respuesta")).toEqual({ sentNow: true, key: "wamid.X" });
      expect(posts).toBe(1);
      expect(await sender.sendReply(1, origin, "respuesta")).toEqual({ sentNow: false, key: "wamid.X" });
      expect(posts).toBe(1);
      expect(sender.sent(1)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("an unknown outcome blocks any resend: later calls inspect the chat or throw", async () => {
    let posts = 0;
    // A 5xx answer is no confirmation: the send's outcome stays unknown.
    const { server, sender } = senderFor((request) => {
      posts++;
      if (request.url.includes("/message/sendText/")) return new Response("upstream lost", { status: 502 });
      return Response.json({ messages: [{ key: { id: "wamid.FOUND" }, message: { conversation: "respuesta" } }] });
    });
    try {
      await expect(sender.sendReply(2, origin, "respuesta")).rejects.toBeInstanceOf(EvoSendError);
      expect(posts).toBe(1);
      // The retry finds our own words in the chat: confirmed without a resend.
      expect(await sender.sendReply(2, origin, "respuesta")).toEqual({ sentNow: false, key: "wamid.FOUND" });
      expect(posts).toBe(2); // still only the one sendText + the inspection
    } finally {
      server.stop(true);
    }
  });

  test("an unresolved earlier send never re-sends, it blocks", async () => {
    let sendTexts = 0;
    const { server, sender } = senderFor((request) => {
      if (request.url.includes("/message/sendText/")) {
        sendTexts++;
        return new Response("upstream lost", { status: 502 }); // first (and every) attempt unconfirmed
      }
      return Response.json({ messages: [] }); // chat inspection finds nothing
    });
    try {
      await expect(sender.sendReply(3, origin, "respuesta")).rejects.toBeInstanceOf(EvoSendError);
      for (let i = 0; i < 3; i++) await expect(sender.sendReply(3, origin, "respuesta")).rejects.toBeInstanceOf(EvoSendError);
      expect(sendTexts).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("the sender refuses a non-loopback base URL", () => {
    const db = new Database(":memory:");
    expect(() => new EvoSender(db, { baseUrl: "https://evil.example", instance: "i", apiKey: "k" })).toThrow(/loopback/);
  });
});

describe("consumer loop", () => {
  test("acknowledges only after a clean delivery; a failure keeps the cursor and retries", async () => {
    const inbox = makeInbox();
    const a = inbox.accept(inbound("uno", "u1"));
    const b = inbox.accept(inbound("dos", "u2"));
    const delivered: number[] = [];
    let failFirst = true;
    const seen: number[] = [];
    const consumer = startChannelConsumer(inbox, { consumer: "c", pollMs: 50, errorBackoffMs: 50 }, {
      process: async (r) => {
        if (!seen.includes(r.seq)) seen.push(r.seq);
        if (r.seq === a.seq && failFirst) {
          failFirst = false;
          throw new Error("first delivery dies");
        }
        delivered.push(r.seq);
      },
    });
    for (let i = 0; i < 200 && !delivered.includes(b.seq); i++) await new Promise((r) => setTimeout(r, 50));
    await consumer.stop();
    expect(delivered).toEqual([a.seq, b.seq]); // a is retried, then b
    const cursor = (inbox.db.query("SELECT cursor FROM channel_consumers WHERE consumer='c'").get() as any).cursor;
    expect(cursor).toBe(b.seq);
    expect(inbox.pending("c").messages.length).toBe(0);
  });
});
