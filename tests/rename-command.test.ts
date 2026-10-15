/**
 * Session titles (v5-A): the /rename operator command renames the session in
 * the shared sessions.db AND the bound group's subject (Evolution
 * /group/updateGroupSubject), with the same allowlist authority as
 * /newsession; a group-subject failure keeps the session renamed and says so.
 * clampTitle enforces the max-4-words spec on anything the model returns.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { ChannelInbox } from "../src/channels/inbox";
import { setGroupSubject, type GroupBridgeOptions } from "../src/channels/groupBridge";
import { planRenameCommand } from "../src/channels/renameCommand";
import { clampTitle, TITLE_MAX_WORDS } from "../src/title";
import { createSession, getSession, openDb } from "../src/sessions";
import type { Inbound } from "../src/channels/inbox";
import type { PendingRow } from "../src/channels/consumer";

const SENDER = "34692747052@s.whatsapp.net";
const GROUP = "120363999999999999@g.us";
const ACCOUNT = "evo";
const SESSION = "wa-evo-deadbeef";

let dir: string;
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { inbox: ChannelInbox; dbPath: string; options: GroupBridgeOptions & { sessionsDbPath: string } } {
  dir = mkdtempSync(join(tmpdir(), "rename-command-"));
  const inbox = new ChannelInbox(join(dir, "channels.sqlite"));
  inbox.bind({ channel: "whatsapp", account: ACCOUNT, thread: GROUP, session: SESSION, project: "wa-assistant", allowedSenders: [SENDER], policy: "all", model: "" });
  const dbPath = join(dir, "sessions.db");
  const db = openDb(dbPath);
  createSession(db, { id: SESSION, cwd: "/tmp", model: "", task: "WhatsApp thread", title: "Old title" });
  db.close();
  const options: GroupBridgeOptions & { sessionsDbPath: string } = {
    inbox,
    accountFor: () => ({ instance: "mini-assistant", token: "x".repeat(40) }),
    baseUrl: "http://127.0.0.1:1",
    newSessionId: () => SESSION,
    senderFor: () => undefined,
    sessionsDbPath: dbPath,
    timeoutMs: 1000,
    log: () => {},
  };
  return { inbox, dbPath, options };
}

function row(): PendingRow {
  return { seq: 1, channel: "whatsapp", account: ACCOUNT, thread: GROUP, message_id: "w1", sent_at: Date.now(), payload: "", session: SESSION, project: "wa-assistant" };
}

function message(text: string): Inbound {
  return { channel: "whatsapp", account: ACCOUNT, thread: GROUP, messageId: "m1", sender: SENDER, sentAt: Date.now(), text, attachments: [] };
}

/** Record every fetch (url, method, body) and answer `status`. */
function stubFetch(status: number, log: Array<{ url: string; method: string; body: string }>): () => void {
  const original = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = async (input: any, init: any) => {
    const body = typeof init?.body === "string" ? init.body : "";
    log.push({ url: String(input), method: String(init?.method ?? "GET"), body });
    return new Response("{}", { status });
  };
  return () => {
    (globalThis as any).fetch = original;
  };
}

describe("clampTitle", () => {
  test("keeps at most 4 words", () => {
    expect(clampTitle("una dos tres cuatro cinco seis").split(" ").length).toBe(TITLE_MAX_WORDS);
    expect(clampTitle("una dos tres cuatro cinco seis")).toBe("una dos tres cuatro");
  });

  test("keeps the first line only, in the user's language", () => {
    expect(clampTitle("Arreglar el login\nnotas del modelo")).toBe("Arreglar el login");
    expect(clampTitle("Fix the login flow")).toBe("Fix the login flow");
  });

  test("empty in, empty out (the fallback stays)", () => {
    expect(clampTitle("   \n  ")).toBe("");
  });
});

describe("planRenameCommand", () => {
  test("a non-command or a non-allowlisted sender is plain text", () => {
    const { options } = fixture();
    expect(planRenameCommand(options, row(), message("hola, hazme un /rename bonito"))).toBeNull();
    const stranger = message("/rename Nuevo título");
    stranger.sender = "9999@s.whatsapp.net";
    expect(planRenameCommand(options, row(), stranger)).toBeNull();
  });

  test("renames the session and the group subject, then confirms", async () => {
    const { options, dbPath } = fixture();
    const calls: Array<{ url: string; method: string; body: string }> = [];
    const restore = stubFetch(200, calls);
    try {
      const plan = planRenameCommand(options, row(), message("/rename Deuda luz agosto"));
      expect(plan).not.toBeNull();
      await plan!.after();
      const db = openDb(dbPath);
      expect(getSession(db, SESSION)?.title).toBe("Deuda luz agosto");
      db.close();
      expect(calls.length).toBe(1);
      expect(calls[0]!.url).toContain("/group/updateGroupSubject/mini-assistant");
      expect(calls[0]!.url).toContain(`groupJid=${encodeURIComponent(GROUP)}`);
      expect(JSON.parse(calls[0]!.body)).toEqual({ groupJid: GROUP, subject: "Deuda luz agosto" });
    } finally {
      restore();
    }
  });

  test("a group-subject refusal keeps the session renamed and says so", async () => {
    const { options, dbPath } = fixture();
    const sent: string[] = [];
    const sender = {
      sendText: async (payload: { text: string }) => {
        sent.push(payload.text);
        return "ok";
      },
    };
    const withSender = { ...options, senderFor: () => sender };
    const calls: Array<{ url: string; method: string; body: string }> = [];
    const restore = stubFetch(403, calls);
    try {
      const plan = planRenameCommand(withSender as any, row(), message("/rename Deuda luz agosto"));
      await plan!.after();
      const db = openDb(dbPath);
      expect(getSession(db, SESSION)?.title).toBe("Deuda luz agosto");
      db.close();
      expect(sent.length).toBe(1);
      expect(sent[0]).toContain("Deuda luz agosto");
      expect(sent[0]).toContain("no pude renombrar el grupo");
    } finally {
      restore();
    }
  });

  test("an empty or oversized title is refused with usage", async () => {
    const { options } = fixture();
    const sent: string[] = [];
    const sender = { sendText: async (payload: { text: string }) => (sent.push(payload.text), "ok") };
    const withSender = { ...options, senderFor: () => sender as any };
    const plan = planRenameCommand(withSender as any, row(), message("/rename"));
    expect(plan).not.toBeNull();
    await plan!.after();
    expect(sent[0]).toContain("Uso: /rename");
    const big = planRenameCommand(withSender as any, row(), message(`/rename ${"x".repeat(300)}`));
    await big!.after();
    expect(sent.length).toBe(2);
  });
});

describe("setGroupSubject", () => {
  test("posts to the group-update route with jid + subject, ok on 2xx", async () => {
    const calls: Array<{ url: string; method: string; body: string }> = [];
    const restore = stubFetch(201, calls);
    try {
      const result = await setGroupSubject("http://127.0.0.1:1/", "mini", "tok", GROUP, "Nuevo asunto");
      expect(result.ok).toBe(true);
      expect(calls[0]!.method).toBe("POST");
      expect(calls[0]!.url).toContain("/group/updateGroupSubject/mini");
      expect(JSON.parse(calls[0]!.body)).toEqual({ groupJid: GROUP, subject: "Nuevo asunto" });
    } finally {
      restore();
    }
  });

  test("a refusal comes back honestly", async () => {
    const restore = stubFetch(500, []);
    try {
      const result = await setGroupSubject("http://127.0.0.1:1", "mini", "tok", GROUP, "x");
      expect(result.ok).toBe(false);
      expect(result.status).toBe(500);
    } finally {
      restore();
    }
  });
});
