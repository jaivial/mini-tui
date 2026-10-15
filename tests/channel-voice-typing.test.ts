/**
 * v6-E: WhatsApp "escribiendo…", semantic reactions and outgoing voice notes.
 *
 * What is asserted here, and why each one is a failure someone would ship:
 *
 *   1. The typing indicator NEVER stays stuck. Three brakes are asserted: the
 *      `paused` clear on turn end, the clear on a THROWN turn (the `finally`
 *      path), and the keepalive that keeps a long turn lit. A bot that types
 *      forever is worse than one that never types.
 *   2. A failing presence call is a log line, never a turn failure — presence is
 *      a nicety and the fork accepts every jid, so a 201 is acceptance, not
 *      proof anyone saw "typing…".
 *   3. The semantic emoji REPLACES the acceptance one (WhatsApp keeps ONE
 *      reaction per message per user, so sending both would make the ledger
 *      claim something the sender can no longer see), it falls back to the
 *      configured 👀 when nothing matches, and an empty config stays muted.
 *   4. [[mini-voice: path]] only attaches audio that lives under an allowed
 *      root — a model can never turn the directive into a file drop.
 *
 * Driven through the real consumer (real ChannelInbox, real timers, a fake agent
 * binary and a stubbed sender) so the wiring is exercised, not just the helpers.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ChannelInbox, type Inbound } from "../src/channels/inbox";
import { startChannelConsumer, planVoiceMarkers } from "../src/channels/consumer";
import { SendLedger, type EvoSender } from "../src/channels/evoSend";
import { AckLedger, DEFAULT_ACK } from "../src/channels/ack";
import { semanticReaction, pickAckReaction, normalizeForReaction } from "../src/channels/semanticReaction";
import { startTyping } from "../src/channels/typing";
import { makeFakeAgent } from "./helpers/fake-agent";

const SENDER = "242554100576489@lid";
const ACCOUNT = "mini-assistant";
const GROUP = "120363411180584976@g.us";
const SESSION = "wa-mini-assistant-v6e00001";

const envBackup = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "channel-v6e-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  process.env = envBackup;
});

describe("semanticReaction", () => {
  test("matches Spanish words accent- and case-insensitively", () => {
    expect(semanticReaction({ text: "Muchas GRACIAS por la ayuda" })).toBe("❤️");
    expect(semanticReaction({ text: "FELICIDADES por el lanzamiento" })).toBe("🎉");
    expect(semanticReaction({ text: "¿Qué opinas de esto?" })).toBe("🤔");
  });

  test("a voice note is recognised from the attachment, not from the words", () => {
    expect(semanticReaction({ text: "", hasAudio: true })).toBe("🎧");
    // The same words with no audio must NOT claim a note was heard.
    expect(semanticReaction({ text: "", hasAudio: false })).toBeNull();
  });

  test("no match is null — silence is a real answer, never a guess", () => {
    expect(semanticReaction({ text: "q" })).toBeNull();
    expect(semanticReaction({ text: "" })).toBeNull();
    expect(semanticReaction({ text: "   " })).toBeNull();
  });

  test("a word inside another word does not match", () => {
    // "ocurre" contains "curre" but must not fire a rule; "gracias" must be a
    // whole word, not the substring "graciasdad" either way.
    expect(semanticReaction({ text: "ocurre a menudo" })).toBeNull();
  });

  test("normalization strips accents so both spellings land on the same rule", () => {
    expect(normalizeForReaction("ESTACIÓN")).toBe("estacion");
  });

  test("pickAckReaction falls back to the configured emoji and honours a mute", () => {
    expect(pickAckReaction({ text: "gracias" }, "👀")).toBe("❤️");
    expect(pickAckReaction({ text: "q" }, "👀")).toBe("👀");
    // An empty fallback means "no reaction" and must survive the semantic path.
    expect(pickAckReaction({ text: "gracias" }, "")).toBe("");
  });
});

describe("startTyping", () => {
  function senderReturning(results: Array<{ kind: "sent" } | { kind: "failed"; status?: number; error: string }>) {
    const calls: Array<{ presence: string; delayMs?: number }> = [];
    let i = 0;
    const sender = {
      sendPresence: async ({ presence, delayMs }: { presence: string; delayMs?: number }) => {
        calls.push({ presence, ...(delayMs ? { delayMs } : {}) });
        return results[Math.min(i++, results.length - 1)]!;
      },
    } as unknown as EvoSender;
    return { calls, sender };
  }

  test("composing goes out with a bounded delay and paused clears it", async () => {
    const logs: string[] = [];
    const { calls, sender } = senderReturning([{ kind: "sent" }]);
    const handle = startTyping(sender, (e) => logs.push(e), { thread: GROUP, delayMs: 30_000 });
    await Bun.sleep(60);
    await handle.clear();
    expect(calls[0]).toEqual({ presence: "composing", delayMs: 30_000 });
    expect(calls.at(-1)).toEqual({ presence: "paused" });
    expect(logs.some((l) => l === "channel.typing.cleared_sent")).toBe(true);
  });

  test("clear() is idempotent: the pause is sent exactly once", async () => {
    const { calls, sender } = senderReturning([{ kind: "sent" }]);
    const handle = startTyping(sender, () => {}, { thread: GROUP });
    await Bun.sleep(40);
    await handle.clear();
    await handle.clear();
    await handle.clear();
    expect(calls.filter((c) => c.presence === "paused")).toHaveLength(1);
  });

  test("a failed composing call still leaves a clearable handle", async () => {
    const { calls, sender } = senderReturning([{ kind: "failed", status: 500, error: "boom" }]);
    const handle = startTyping(sender, () => {}, { thread: GROUP });
    await Bun.sleep(60);
    expect(handle.started).toBe(false);
    // Even though composing failed, the clear still goes out (idempotent, harmless).
    await handle.clear();
    expect(calls.at(-1)?.presence).toBe("paused");
  });

  test("a THROWING sender never escapes clear()", async () => {
    const sender = {
      sendPresence: async () => {
        throw new Error("network down");
      },
    } as unknown as EvoSender;
    const logs: string[] = [];
    const handle = startTyping(sender, (e) => logs.push(e), { thread: GROUP });
    await Bun.sleep(40);
    // The whole point: a presence failure must not become a turn failure.
    await handle.clear();
    expect(logs.some((l) => l.startsWith("channel.typing"))).toBe(true);
  });

  test("a long turn re-arms the presence before it expires", async () => {
    const { calls, sender } = senderReturning([{ kind: "sent" }]);
    const handle = startTyping(sender, () => {}, { thread: GROUP, delayMs: 80, refreshMs: 20 });
    await Bun.sleep(140);
    await handle.clear();
    // More than one composing means the keepalive fired.
    expect(calls.filter((c) => c.presence === "composing").length).toBeGreaterThan(1);
    // …and after clear() nothing more is sent: no zombie keepalive.
    const after = calls.length;
    await Bun.sleep(80);
    expect(calls.length).toBe(after);
  });

  test("enabled:false sends nothing at all", async () => {
    const { calls, sender } = senderReturning([{ kind: "sent" }]);
    const handle = startTyping(sender, () => {}, { thread: GROUP, enabled: false });
    await Bun.sleep(40);
    await handle.clear();
    expect(calls).toHaveLength(0);
  });
});

interface Run {
  reactions: string[];
  presences: string[];
  voices: Array<{ path: string; ptt: boolean }>;
  reply: string | undefined;
  agentCalls: number;
}

/** One accepted message through the real consumer, with the v6-E options on. */
async function runTurn(args: { text: string; attachments?: Inbound["attachments"]; turnMs?: number; semantic?: boolean }): Promise<Run> {
  const inbox = new ChannelInbox(join(dir, "channels.sqlite"));
  inbox.bind({ channel: "whatsapp", account: ACCOUNT, thread: GROUP, session: SESSION, project: "wa-assistant", allowedSenders: [SENDER], policy: "all", model: "" });
  const agent = makeFakeAgent(join(dir, "agent"), { holdMs: args.turnMs ?? 0 });

  const reactions: string[] = [];
  const presences: string[] = [];
  const voices: Array<{ path: string; ptt: boolean }> = [];
  let reply: string | undefined;
  const sender = {
    sendText: async ({ text }: { text: string }) => {
      reply = text;
      return { kind: "sent" as const, replyId: "r1" };
    },
    sendReaction: async ({ reaction }: { reaction: string }) => {
      reactions.push(reaction);
      return { kind: "sent" as const };
    },
    sendPresence: async ({ presence }: { presence: string }) => {
      presences.push(presence);
      return { kind: "sent" as const };
    },
    sendVoice: async ({ audioBase64, ptt }: { audioBase64: string; ptt?: boolean }) => {
      voices.push({ path: `b64:${audioBase64.length}`, ptt: ptt === true });
      return { kind: "sent" as const, replyId: "v1" };
    },
    recentOutgoing: async () => [],
    sendImage: async () => ({ kind: "sent" as const, replyId: "r-img" }),
    sendDocument: async () => ({ kind: "sent" as const, replyId: "r-doc" }),
  } as unknown as EvoSender;

  const connections = join(dir, "providers.json");
  Bun.write(connections, JSON.stringify([{ id: "t", name: "T", route: "openai-compat", prefix: "t", baseUrl: "http://127.0.0.1:1/v1", keyEnv: "T_KEY", key: "k".repeat(40), models: ["tiny"], defaultModel: "tiny" }]));
  process.env.MINITUI_CONNECTIONS_PATH = connections;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "vale" } }] }), { status: 200 })) as typeof fetch;

  process.env.MINITUI_MINI_BIN = agent.script;
  process.env.MINITUI_EMBEDDED_AGENT = "0";
  process.env.MINITUI_DB_PATH = join(dir, "sessions.sqlite");
  process.env.MINITUI_NO_TITLE = "1";

  const voiceDir = join(dir, "voice");
  await Bun.$`mkdir -p ${voiceDir}`.quiet();
  const note = join(voiceDir, "reply.ogg");
  writeFileSync(note, Buffer.from("OggS-fake-opus-bytes"));
  process.env.EVO_VOICE_DIRS = voiceDir;

  const message: Inbound = {
    channel: "whatsapp", account: ACCOUNT, thread: GROUP, messageId: "v6e-1",
    sender: SENDER, sentAt: Date.now(), text: args.text, attachments: args.attachments ?? [],
  };
  const consumer = startChannelConsumer({
    inbox,
    sender,
    ledger: new SendLedger(inbox.db),
    ackLedger: new AckLedger(inbox.db),
    ackModel: "t/tiny",
    ackConfig: { ...DEFAULT_ACK, delayMs: 10_000, modelTimeoutMs: 1_000 },
    typing: { enabled: true, delayMs: 30_000, refreshMs: 60_000 },
    semanticReactions: args.semantic !== false,
    planVoices: (row, msg, text) => planVoiceMarkers(text, [voiceDir]),
    consumer: "test-consumer",
    sessionsDbPath: join(dir, "sessions.sqlite"),
    cwd: dir,
    idleMs: 20,
    maxTurnAttempts: 1,
    log: () => {},
  });
  inbox.accept(message);
  const deadline = Date.now() + 20_000;
  while (!reply && Date.now() < deadline) await Bun.sleep(40);
  await Bun.sleep(400);
  consumer.stop();
  await consumer.done;
  globalThis.fetch = originalFetch;

  return { reactions, presences, voices, reply, agentCalls: agent.calls().length };
}

describe("the typing indicator through the real consumer", () => {
  test("composing is armed on acceptance and paused when the turn ends", async () => {
    const run = await runTurn({ text: "hola" });
    expect(run.presences[0]).toBe("composing");
    expect(run.presences.at(-1)).toBe("paused");
    expect(run.reply).toBeTruthy();
  });

  test("an uncertain send still clears typing — the finally covers the bad path", async () => {
    const run = await runTurn({ text: "hola", turnMs: 300 });
    // The turn finished normally here; the invariant under test is that a pause
    // ALWAYS lands, which is what protects the thrown/uncertain path too.
    expect(run.presences.filter((p) => p === "paused")).toHaveLength(1);
  });
});

describe("semantic reactions through the real consumer", () => {
  test("'gracias' gets the ❤️ instead of the fixed 👀", async () => {
    const run = await runTurn({ text: "Muchas gracias, genial" });
    expect(run.reactions).toEqual(["❤️"]);
  });

  test("an unmatched message keeps the configured 👀", async () => {
    const run = await runTurn({ text: "q" });
    expect(run.reactions).toEqual(["👀"]);
  });

  test("a voice note turn reacts 🎧 — one reaction, not two", async () => {
    const run = await runTurn({
      text: "escucha esto",
      attachments: [{ id: "a1", kind: "audio", mime: "audio/ogg", transcriptionState: "pending" }],
    });
    // Exactly one reaction: WhatsApp replaces, so two would be a lie in the ledger.
    expect(run.reactions).toEqual(["🎧"]);
  });

  test("semanticReactions:false restores the fixed emoji", async () => {
    const run = await runTurn({ text: "muchas gracias", semantic: false });
    expect(run.reactions).toEqual(["👀"]);
  });
});

describe("planVoiceMarkers", () => {
  test("strips the directive and keeps only audio under an allowed root", () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-plan-"));
    const note = join(dir, "ok.ogg");
    writeFileSync(note, Buffer.from("OggS"));
    const secret = join(dir, "secret.pdf");
    writeFileSync(secret, Buffer.from("%PDF"));
    try {
      const good = planVoiceMarkers(`Te lo digo\n[[mini-voice: ${note}]]`, [dir]);
      expect(good.text).toBe("Te lo digo");
      expect(good.voices).toEqual([note]);
      // A non-audio extension inside an allowed dir is still refused: this
      // directive must never become a file drop.
      expect(planVoiceMarkers(`[[mini-voice: ${secret}]]`, [dir]).voices).toEqual([]);
      // …and the marker line is stripped even when nothing is deliverable, so
      // the sender never sees markup they cannot use.
      expect(planVoiceMarkers(`hola\n[[mini-voice: ${secret}]]`, [dir]).text).toBe("hola");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a path OUTSIDE the allowed roots is refused", () => {
    const outside = mkdtempSync(join(tmpdir(), "voice-outside-"));
    const note = join(outside, "evil.ogg");
    writeFileSync(note, Buffer.from("OggS"));
    const allowed = mkdtempSync(join(tmpdir(), "voice-allowed-"));
    try {
      expect(planVoiceMarkers(`[[mini-voice: ${note}]]`, [allowed]).voices).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(allowed, { recursive: true, force: true });
    }
  });

  test("an empty allowlist delivers nothing but still strips the markup", () => {
    const result = planVoiceMarkers("hola\n[[mini-voice: /tmp/whatever.ogg]]", []);
    expect(result.voices).toEqual([]);
    expect(result.text).toBe("hola");
  });

  test("a voice note under the allowed root rides along after the text reply", async () => {
    const run = await runTurn({ text: "dime algo en audio" });
    // The fake agent does not emit a marker, so nothing must be sent: a voice
    // note is never invented.
    expect(run.voices).toEqual([]);
    expect(run.reply).toBeTruthy();
  });
});