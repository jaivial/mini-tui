/**
 * v6-F: a restart in the middle of a turn must not repeat the acknowledgment.
 *
 * The cursor only advances on `acknowledge`, so a consumer that dies with a
 * turn in flight leaves its row for the NEXT process to replay. On 2026-10-15
 * five restarts during one slow turn (each one SIGKILLed after TimeoutStopSec)
 * sent FIVE "recibido" lines to the same WhatsApp message: the durable ack
 * ledger knew the line had been delivered, and nothing read it.
 *
 * Driven through the real consumer and the real ledger; the model call is
 * stubbed and COUNTED, because "the line was already out" must also mean the
 * line is not written again.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { ChannelInbox, type Inbound } from "../src/channels/inbox";
import { startChannelConsumer } from "../src/channels/consumer";
import { SendLedger, type EvoSender } from "../src/channels/evoSend";
import { AckLedger, DEFAULT_ACK } from "../src/channels/ack";
import { makeFakeAgent } from "./helpers/fake-agent";

const SENDER = "242554100576489@lid";
const ACCOUNT = "mini-assistant";
const GROUP = "120363411180584976@g.us";
const SESSION = "wa-mini-assistant-8bfe4ead";
const LINE = "Recibido, lo miro y te digo";

const envBackup = { ...process.env };
let dir: string;

afterAll(() => {
  process.env = envBackup;
});

interface Run {
  texts: string[];
  modelCalls: number;
  logs: string[];
  cursor: number;
}

/** One accepted message, one consumer, one restart-shaped precondition. */
async function runTurn(seed: (ledger: AckLedger) => void, opts: { turnMs?: number } = {}): Promise<Run> {
  dir = mkdtempSync(join(tmpdir(), "ack-restart-"));
  const inbox = new ChannelInbox(join(dir, "channels.sqlite"));
  const agent = makeFakeAgent(join(dir, "agent"), { holdMs: opts.turnMs ?? 0 });
  Bun.write(
    join(dir, "providers.json"),
    JSON.stringify([{ id: "test", name: "Test", route: "openai-compat", prefix: "test", baseUrl: "http://127.0.0.1:1/v1", keyEnv: "TEST_KEY", key: "k".repeat(40), models: ["tiny"], defaultModel: "tiny" }]),
  );
  process.env.MINITUI_CONNECTIONS_PATH = join(dir, "providers.json");
  process.env.MINITUI_MINI_BIN = agent.script;
  process.env.MINITUI_EMBEDDED_AGENT = "0";
  process.env.MINITUI_DB_PATH = join(dir, "sessions.sqlite");
  process.env.MINITUI_NO_TITLE = "1";

  let modelCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes("/chat/completions")) {
      modelCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: LINE } }] }), { status: 200 });
    }
    return originalFetch(input as never);
  }) as typeof fetch;

  const texts: string[] = [];
  const sender = {
    sendText: async ({ text }: { text: string }) => {
      texts.push(text);
      return { kind: "sent" as const, replyId: `r${texts.length}` };
    },
    sendReaction: async () => ({ kind: "sent" as const }),
    recentOutgoing: async () => [],
    sendPresence: async () => ({ kind: "sent" as const }),
    sendImage: async () => ({ kind: "sent" as const, replyId: "i" }),
    sendDocument: async () => ({ kind: "sent" as const, replyId: "d" }),
  } as unknown as EvoSender;

  const ackLedger = new AckLedger(inbox.db);
  const logs: string[] = [];
  // A consumer was ALREADY running when the message arrived — that is what puts
  // an accepted row ahead of the cursor, and it is the state a restart replays
  // from. (Starting the consumer afterwards would sync its cursor at the newest
  // seq and never see the row.)
  inbox.sync("test-consumer");
  inbox.bind({ channel: "whatsapp", account: ACCOUNT, thread: GROUP, session: SESSION, project: "wa-assistant", allowedSenders: [SENDER], policy: "all", model: "" });
  const message: Inbound = { channel: "whatsapp", account: ACCOUNT, thread: GROUP, messageId: "ack-restart-1", sender: SENDER, sentAt: Date.now(), text: "revisa el despliegue y dime que ves", attachments: [] };
  inbox.accept(message);
  // The durable state the killed process left behind, written before the
  // consumer can touch the row.
  seed(ackLedger);

  const consumer = startChannelConsumer({
    inbox,
    sender,
    ledger: new SendLedger(inbox.db),
    ackLedger,
    ackModel: "test/tiny",
    ackConfig: { ...DEFAULT_ACK, delayMs: 100, modelTimeoutMs: 1_000 },
    consumer: "test-consumer",
    sessionsDbPath: join(dir, "sessions.sqlite"),
    cwd: dir,
    idleMs: 20,
    maxTurnAttempts: 1,
    log: (event) => logs.push(event),
  });
  const deadline = Date.now() + 20_000;
  const replied = () => texts.some((t) => t.startsWith("fake reply to:"));
  while (!replied() && Date.now() < deadline) await Bun.sleep(40);
  await Bun.sleep(300);
  consumer.stop();
  await consumer.done;
  globalThis.fetch = originalFetch;
  const cursor = (inbox.db.query("SELECT cursor FROM channel_consumers WHERE consumer='test-consumer'").get() as { cursor: number }).cursor;
  return { texts, modelCalls, logs, cursor };
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("the ack across a restart", () => {
  test("a line the previous process already delivered is not written or sent again", async () => {
    const run = await runTurn((ledger) => {
      // Exactly what the process that was killed mid-turn left behind.
      ledger.markReaction(1, "👀", "sent");
      ledger.markGenerated(1, LINE, "test/tiny", 120);
      ledger.markDisposition(1, "sent", LINE, 480);
    }, { turnMs: 500 });
    expect(run.texts.filter((t) => t === LINE)).toEqual([]);
    expect(run.modelCalls).toBe(0);
    expect(run.logs).toContain("channel.ack.skipped_already_sent");
    // The turn is NOT lost: the reply still goes out and the cursor advances.
    expect(run.texts.some((t) => t.startsWith("fake reply to:"))).toBe(true);
    expect(run.cursor).toBe(1);
  });

  test("an uncertain attempt is still re-attempted (only proven delivery suppresses)", async () => {
    const run = await runTurn((ledger) => {
      // `failed` also stores its text: it must NOT be read as proof of delivery.
      ledger.markGenerated(1, LINE, "test/tiny", 120);
      ledger.markDisposition(1, "failed", LINE, 480, "socket hang up");
    }, { turnMs: 500 });
    expect(run.texts[0]).toBe(LINE);
    expect(run.modelCalls).toBe(1);
    expect(run.logs).not.toContain("channel.ack.skipped_already_sent");
  });

  test("a fresh row is acknowledged normally", async () => {
    const run = await runTurn(() => {}, { turnMs: 500 });
    expect(run.texts[0]).toBe(LINE);
    expect(run.modelCalls).toBe(1);
  });
});
