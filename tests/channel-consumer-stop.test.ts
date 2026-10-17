/**
 * E2: a stop request must abort the turn in flight, not wait it out.
 *
 * Every deploy of this service ends in SIGTERM. `startChannelConsumer`'s `stop()`
 * only flipped a flag and woke the IDLE sleep, so with a turn running the loop
 * sat in `await processOne(...)` until the turn finished on its own: the
 * service's own `TimeoutStopSec=1min 30s` expired first, systemd SIGKILLed the
 * whole control group (the agent with it), and the row — whose cursor only
 * advances on `acknowledge` — went back to the NEXT process, which ran the
 * whole turn again. Measured 2026-10-15: five `Failed with result 'timeout'`
 * in 12 h and one message re-executed four times.
 *
 * So this asserts three separate things, all of which a "stop = set the flag"
 * implementation fails:
 *   1. `done` resolves promptly after `stop()` — not when the turn would have
 *      ended on its own (the turn here is 20x longer than the budget).
 *   2. The turn in flight is actually torn down (its run is killed), not merely
 *      abandoned.
 *   3. An interrupted turn is NOT reported to the sender as a failed turn: a
 *      deploy is not the sender's fault, and a "I couldn't do that" note
 *      arriving minutes later for work the next process is about to redo is the
 *      worst of both worlds. The row stays unacknowledged for the next process.
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
const SESSION = "wa-mini-assistant-e2stop001";

const envBackup = { ...process.env };
let dir: string;

afterAll(() => {
  process.env = envBackup;
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

interface StopRun {
  texts: string[];
  logs: string[];
  cursor: number;
  /** ms from `stop()` to `done` settling. */
  stopMs: number;
  /** The turn had not ended on its own when we stopped (sanity: the slow path). */
  turnWasInFlight: boolean;
}

async function stopDuringTurn(turnMs: number): Promise<StopRun> {
  dir = mkdtempSync(join(tmpdir(), "consumer-stop-"));
  const inbox = new ChannelInbox(join(dir, "channels.sqlite"));
  const agent = makeFakeAgent(join(dir, "agent"), { holdMs: turnMs });
  Bun.write(
    join(dir, "providers.json"),
    JSON.stringify([{ id: "test", name: "Test", route: "openai-compat", prefix: "test", baseUrl: "http://127.0.0.1:1/v1", keyEnv: "TEST_KEY", key: "k".repeat(40), models: ["tiny"], defaultModel: "tiny" }]),
  );
  process.env.MINITUI_CONNECTIONS_PATH = join(dir, "providers.json");
  process.env.MINITUI_MINI_BIN = agent.script;
  process.env.MINITUI_EMBEDDED_AGENT = "0";
  process.env.MINITUI_DB_PATH = join(dir, "sessions.sqlite");
  process.env.MINITUI_NO_TITLE = "1";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes("/chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "Recibido" } }] }), { status: 200 });
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

  const logs: string[] = [];
  inbox.sync("test-consumer");
  inbox.bind({ channel: "whatsapp", account: ACCOUNT, thread: GROUP, session: SESSION, project: "wa-assistant", allowedSenders: [SENDER], policy: "all", model: "" });
  const message: Inbound = { channel: "whatsapp", account: ACCOUNT, thread: GROUP, messageId: "e2stop-1", sender: SENDER, sentAt: Date.now(), text: "revisa el despliegue y dime que ves", attachments: [] };
  inbox.accept(message);

  const consumer = startChannelConsumer({
    inbox,
    sender,
    ledger: new SendLedger(inbox.db),
    ackLedger: new AckLedger(inbox.db),
    ackModel: "test/tiny",
    ackConfig: { ...DEFAULT_ACK, delayMs: 100, modelTimeoutMs: 1_000 },
    consumer: "test-consumer",
    sessionsDbPath: join(dir, "sessions.sqlite"),
    cwd: dir,
    idleMs: 20,
    maxTurnAttempts: 1,
    log: (event, fields) => logs.push(`${event}${fields ? " " + JSON.stringify(fields) : ""}`),
  });

  // Wait until the turn really is running (the agent process was spawned), so we
  // are testing the in-flight case and not an idle stop.
  const spawned = Date.now() + 10_000;
  while (!agent.calls().length && Date.now() < spawned) await Bun.sleep(20);
  const inFlight = agent.calls().length > 0;
  await Bun.sleep(50);

  const at = Date.now();
  consumer.stop();
  let settled = false;
  await Promise.race([consumer.done.then(() => { settled = true; }), Bun.sleep(15_000)]);
  const stopMs = Date.now() - at;
  globalThis.fetch = originalFetch;

  const cursor = (inbox.db.query("SELECT cursor FROM channel_consumers WHERE consumer='test-consumer'").get() as { cursor: number }).cursor;
  return { texts, logs, cursor, stopMs, turnWasInFlight: inFlight };
}

describe("stopping the consumer with a turn in flight (E2)", () => {
  test("the turn is torn down and `done` settles long before the turn would have ended", async () => {
    const run = await stopDuringTurn(8_000);
    expect(run.turnWasInFlight).toBe(true);
    // The turn needs 8 s on its own. A stop must not wait it out.
    expect(run.stopMs).toBeLessThan(4_000);
  }, 40_000);

  test("an aborted turn sends no failure note and leaves the row for the next process", async () => {
    const run = await stopDuringTurn(8_000);
    // A deploy is not the sender's fault: no "I couldn't do that" goes out.
    expect(run.texts).toEqual([]);
    // And the row is NOT acknowledged, so the next process replays it.
    expect(run.cursor).toBe(0);
    expect(run.logs.some((l) => l.startsWith("channel.consumer.stopped"))).toBe(true);
  }, 40_000);
});
