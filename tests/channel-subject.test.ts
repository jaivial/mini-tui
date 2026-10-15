/**
 * The sender's words travel with the turn, so the runner can tell a greeting from a task.
 *
 * `turnPrompt` wraps every WhatsApp message in a transport frame (thread header, reply-format
 * rules, queue directives). That frame is ~176 words, so the agent's intent classifier reads a
 * bare "qué tal" as work and puts it through the goal-closure judge — which rejected the closure,
 * told the model so, and the chatter about the judgement is what reached the chat instead of the
 * answer. `MINI_CHANNEL_SUBJECT` carries the unframed text beside the prompt so the agent judges
 * what the sender actually wrote.
 *
 * This drives the real consumer end to end (real ChannelInbox, real turn prompt, real runHeadless)
 * with a fake agent binary, and asserts what that agent was actually asked and told.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { ChannelInbox, type Inbound } from "../src/channels/inbox";
import { startChannelConsumer } from "../src/channels/consumer";
import { SendLedger, type EvoSender } from "../src/channels/evoSend";
import { makeFakeAgent } from "./helpers/fake-agent";

const SENDER = "242554100576489@lid";
const ACCOUNT = "mini-assistant";
const GROUP = "120363411180584976@g.us";
const SESSION = "wa-mini-assistant-8bfe4ead";

const envBackup = { ...process.env };
let dir: string;

afterAll(() => {
  process.env = envBackup;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Run one accepted message through the consumer and return what the agent was asked. */
async function turn(senderText: string): Promise<{ task: string; env: Record<string, string> }> {
  dir = mkdtempSync(join(tmpdir(), "channel-subject-"));
  const inbox = new ChannelInbox(join(dir, "channels.sqlite"));
  inbox.bind({ channel: "whatsapp", account: ACCOUNT, thread: GROUP, session: SESSION, project: "wa-assistant", allowedSenders: [SENDER], policy: "all", model: "" });
  const agent = makeFakeAgent(join(dir, "agent"));

  const sent: string[] = [];
  const sender: EvoSender = {
    sendText: async ({ text }: { text: string }) => {
      sent.push(text);
      return { kind: "sent", replyId: `r${sent.length}` };
    },
    sendImage: async () => ({ kind: "sent", replyId: "r-img" }),
    recentOutgoing: async () => [],
  } as unknown as EvoSender;

  // The agent is the only external thing here: no model, no network, no services.
  process.env.MINITUI_MINI_BIN = agent.script;
  process.env.MINITUI_EMBEDDED_AGENT = "0";
  process.env.MINITUI_DB_PATH = join(dir, "sessions.sqlite");
  process.env.MINITUI_NO_TITLE = "1";
  delete process.env.MINI_CHANNEL_SUBJECT;

  const message: Inbound = { channel: "whatsapp", account: ACCOUNT, thread: GROUP, messageId: "e2e-1", sender: SENDER, sentAt: Date.now(), text: senderText, attachments: [] };

  const consumer = startChannelConsumer({
    inbox,
    sender,
    ledger: new SendLedger(inbox.db),
    consumer: "test-consumer",
    sessionsDbPath: join(dir, "sessions.sqlite"),
    cwd: dir,
    model: "",
    idleMs: 20,
    maxTurnAttempts: 1,
    log: () => {},
  });
  // A new consumer starts its cursor at the present (five stale rows would each become a
  // live agent turn), so the message is delivered once it is already watching.
  inbox.accept(message);

  const deadline = Date.now() + 20_000;
  while (!sent.length && Date.now() < deadline) await Bun.sleep(50);
  consumer.stop();
  await consumer.done;

  const calls = agent.calls();
  expect(calls.length).toBe(1);
  return { task: calls[0]!.task, env: calls[0]!.env };
}

describe("the channel subject", () => {
  test("reaches the agent beside the framed prompt, so a greeting is not read as work", async () => {
    const { task, env } = await turn("qué tal");
    // The prompt is still the framed one: the model keeps every transport instruction.
    expect(task).toContain(`[WhatsApp message received in bound thread ${GROUP}`);
    expect(task).toContain("[[mini-queue:");
    // And the sender's own words travel next to it, unframed and exact.
    expect(env.MINI_CHANNEL_SUBJECT).toBe("qué tal");
  });

  test("carries a task's words verbatim, unchanged by the frame", async () => {
    const text = "mira los logs del servidor y dime si hay errores";
    const { env } = await turn(text);
    expect(env.MINI_CHANNEL_SUBJECT).toBe(text);
  });
});