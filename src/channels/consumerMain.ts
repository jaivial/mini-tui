/**
 * `bun run src/channels/consumerMain.ts` — the WhatsApp channel consumer daemon.
 *
 * Reads accepted inbox rows behind a durable cursor, runs each one as a real
 * mini session turn (the shared sessions.db), and sends the session's reply
 * back to the thread as a quoted WhatsApp reply. All configuration comes from
 * the environment (the systemd unit's 0600 env file); the instance token is
 * read but never logged.
 *
 *   EVO_INBOX_DB            the shared channel store (same as the receiver's)
 *   EVO_CONSUMER_NAME       durable consumer name (its inbox cursor)
 *   EVO_API_URL             evo-weai base URL (loopback)
 *   EVO_INSTANCE            instance name (mini-assistant)
 *   EVO_INSTANCE_TOKEN      instance apikey (0600 env, never logged)
 *   MINITUI_DB_PATH         the shared sessions.db
 *   EVO_CONSUMER_CWD        working directory of the agent turns (default ~/wa-assistant)
 *   MINITUI_MODEL           model for new sessions (empty = default chain)
 *   EVO_CONSUMER_TURN_TIMEOUT_S  agent turn wall-clock limit (default 600)
 */

import { ChannelInbox } from "./inbox";
import { SendLedger, createEvoSender } from "./evoSend";
import { startChannelConsumer } from "./consumer";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`consumer: missing ${name}`);
    process.exit(2);
  }
  return value;
}

const inboxPath = required("EVO_INBOX_DB");
const inbox = new ChannelInbox(inboxPath);
const sender = createEvoSender({
  baseUrl: required("EVO_API_URL"),
  instance: required("EVO_INSTANCE"),
  token: required("EVO_INSTANCE_TOKEN"),
  timeoutMs: Number(process.env.EVO_SEND_TIMEOUT_MS ?? 20_000),
});
const turnTimeoutS = Number(process.env.EVO_CONSUMER_TURN_TIMEOUT_S ?? 600);
const { done, stop } = startChannelConsumer({
  inbox,
  sender,
  ledger: new SendLedger(inbox.db),
  consumer: required("EVO_CONSUMER_NAME"),
  sessionsDbPath: process.env.MINITUI_DB_PATH,
  cwd: process.env.EVO_CONSUMER_CWD,
  model: process.env.MINITUI_MODEL ?? "",
  turnTimeoutS: Number.isFinite(turnTimeoutS) && turnTimeoutS > 0 ? turnTimeoutS : 600,
  log: (event, fields = {}) => {
    // Structured, journal-friendly; the token never appears in any field.
    const parts = Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k}=${typeof v === "string" && /[\s="]/.test(v) ? JSON.stringify(v) : v}`);
    console.log(`[mini-channel-consumer] ${event}${parts.length ? " " + parts.join(" ") : ""}`);
  },
});
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
done.then(
  () => {
    inbox.close();
    process.exit(0);
  },
  (error) => {
    console.error(`consumer: fatal: ${error instanceof Error ? error.message : String(error)}`);
    inbox.close();
    process.exit(1);
  },
);
