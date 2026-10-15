/**
 * QA harness: a RESTART in the middle of a turn.
 *
 * What it does, phase by phase, with real processes and the real consumer:
 *   1. one accepted WhatsApp message into a temp channel DB; the agent turn is
 *      slow (the fake agent holds), so the ack line is the only thing sent;
 *   2. the consumer process group is SIGKILLed exactly like systemd does after
 *      TimeoutStopSec (`KillMode=control-group`) — the row is left
 *      unacknowledged, which is what production leaves behind;
 *   3. a second consumer process starts on the same durable DB and reprocesses
 *      the unacknowledged row.
 *
 * Then it counts how many times the ack line reached the thread. One message
 * must never produce two "recibido" lines.
 *
 *   bun scripts/restart-ack-repro.ts run
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ChannelInbox, type Inbound } from "../src/channels/inbox";
import { startChannelConsumer } from "../src/channels/consumer";
import { SendLedger, type EvoSender } from "../src/channels/evoSend";
import { AckLedger, DEFAULT_ACK } from "../src/channels/ack";
import { makeFakeAgent } from "../tests/helpers/fake-agent";

const SENDER = "242554100576489@lid";
const ACCOUNT = "mini-assistant";
const THREAD = "120363411180584976@g.us";
const SESSION = "wa-mini-assistant-8bfe4ead";
/** The stubbed model's ack line; anything else on the sink is the turn's reply. */
const ACK_LINE = "ACK-PROBE recibido";

const [mode, dirArg, holdArg, acceptArg] = process.argv.slice(2);

async function harness(dir: string, holdMs: number, accept: boolean): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const agent = makeFakeAgent(join(dir, "agent"), { holdMs });
  writeFileSync(
    join(dir, "providers.json"),
    JSON.stringify([
      { id: "test", name: "Test", route: "openai-compat", prefix: "test", baseUrl: "http://127.0.0.1:1/v1", keyEnv: "TEST_KEY", key: "k".repeat(40), models: ["tiny"], defaultModel: "tiny" },
    ]),
  );
  process.env.MINITUI_CONNECTIONS_PATH = join(dir, "providers.json");
  process.env.MINITUI_MINI_BIN = agent.script;
  process.env.MINITUI_EMBEDDED_AGENT = "0";
  process.env.MINITUI_DB_PATH = join(dir, "sessions.sqlite");
  process.env.MINITUI_NO_TITLE = "1";
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes("/chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: ACK_LINE } }] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${String(input)}`);
  }) as typeof fetch;

  const sink = join(dir, "sent.jsonl");
  const logPath = join(dir, "consumer.log");
  const inbox = new ChannelInbox(join(dir, "channels.sqlite"));
  const sender = {
    sendText: async ({ text }: { text: string }) => {
      appendFileSync(sink, JSON.stringify({ kind: text.startsWith("fake reply to:") ? "reply" : "ack", text, at: Date.now() }) + "\n");
      return { kind: "sent" as const, replyId: `p${Date.now().toString(36)}` };
    },
    sendReaction: async () => ({ kind: "sent" as const }),
    recentOutgoing: async () => [],
    sendPresence: async () => ({ kind: "sent" as const }),
    sendImage: async () => ({ kind: "sent" as const, replyId: "img" }),
    sendDocument: async () => ({ kind: "sent" as const, replyId: "doc" }),
  } as unknown as EvoSender;
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    appendFileSync(logPath, `${new Date().toISOString()} ${event} ${JSON.stringify(fields)}\n`);

  const consumer = startChannelConsumer({
    inbox,
    sender,
    ledger: new SendLedger(inbox.db),
    ackLedger: new AckLedger(inbox.db),
    ackModel: "test/tiny",
    ackConfig: { ...DEFAULT_ACK, delayMs: 300, modelTimeoutMs: 1_500 },
    consumer: "whatsapp-outbound",
    sessionsDbPath: join(dir, "sessions.sqlite"),
    cwd: dir,
    idleMs: 50,
    maxTurnAttempts: 1,
    log,
  });
  // The message is accepted AFTER the consumer starts (its cursor syncs at 0 on
  // an empty DB), exactly like the real receiver: an accepted row is always
  // ahead of the cursor of a consumer that was already running.
  if (accept) {
    inbox.bind({ channel: "whatsapp", account: ACCOUNT, thread: THREAD, session: SESSION, project: "wa-assistant", allowedSenders: [SENDER], policy: "all", model: "" });
    const message: Inbound = { channel: "whatsapp", account: ACCOUNT, thread: THREAD, messageId: "restart-ack-1", sender: SENDER, sentAt: Date.now(), text: "revisa el estado del despliegue y dime que ves", attachments: [] };
    inbox.accept(message);
    await new Promise<void>(() => {}); // phase 1 runs until the caller kills us
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const done = inbox.db.query("SELECT state FROM channel_sends WHERE inbox_seq=1").get() as { state: string } | null;
    if (done?.state === "sent") break;
    await Bun.sleep(50);
  }
  consumer.stop();
  log("harness.phase2.done", {});
  await Bun.sleep(200);
  process.exit(0);
}

async function run(): Promise<void> {
  const dir = join(process.env.HOME ?? "/tmp", ".hermes/cache/scratch/restart-ack");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const self = import.meta.path;
  const bunBin = process.execPath;
  const spawn = (hold: number, accept: boolean) =>
    Bun.spawn([bunBin, "run", self, "harness", dir, String(hold), accept ? "accept" : "no-accept"], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      detached: true, // its own process group, so the kill is the cgroup kill systemd does
    });

  const p1 = spawn(60_000, true);
  const sink = join(dir, "sent.jsonl");
  const waitFor = async (predicate: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !predicate()) await Bun.sleep(100);
    return predicate();
  };
  const acks = () => (existsSync(sink) ? readFileSync(sink, "utf8").split("\n").filter(Boolean).filter((l) => JSON.parse(l).kind === "ack").length : 0);
  const acked = await waitFor(() => acks() >= 1, 30_000);
  console.log(`phase 1: ack sent=${acked} (acks=${acks()})`);
  try {
    process.kill(-p1.pid, "SIGKILL"); // the process group
  } catch (error) {
    console.log(`kill failed: ${(error as Error).message}`);
  }
  await Bun.sleep(500);

  const p2 = spawn(0, false);
  await p2.exited;
  await Bun.sleep(500);
  const lines = existsSync(sink) ? readFileSync(sink, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; text: string }) : [];
  const skipped = existsSync(join(dir, "consumer.log")) && readFileSync(join(dir, "consumer.log"), "utf8").includes("ack.skipped_already_sent");
  console.log(`sent lines: ${JSON.stringify(lines.map((l) => l.kind))}`);
  console.log(`ACK LINES TOTAL: ${lines.filter((l) => l.kind === "ack").length}  replies: ${lines.filter((l) => l.kind === "reply").length}`);
  console.log(`skip guard fired: ${skipped}`);
  console.log(`dir: ${dir}`);
  console.log(lines.filter((l) => l.kind === "ack").length > 1 ? "VERDICT: DUPLICATE ACK (bug reproduced)" : "VERDICT: exactly one ack");
}

if (mode === "harness") await harness(dirArg as string, Number(holdArg), acceptArg === "accept");
else await run();
