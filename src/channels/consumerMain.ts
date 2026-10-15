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
 *   EVO_ACCOUNTS            WA-5 multichat: JSON array, one identity per
 *                           instance — [{"account","instance","token","jid?"}…]
 *                           (0600 env; tokens are read, never logged)
 *   EVO_INSTANCE            single-account form (WA-2), used when EVO_ACCOUNTS
 *   EVO_INSTANCE_TOKEN      is absent; EVO_ACCOUNT_JID adds the mention-gate
 *                           jid for that one identity
 *   MINITUI_DB_PATH         the shared sessions.db
 *   EVO_CONSUMER_CWD        working directory of the agent turns (default ~/wa-assistant)
 *   MINITUI_MODEL           model for new sessions (empty = default chain)
 *   EVO_CONSUMER_TURN_TIMEOUT_S  agent turn wall-clock limit (default 600)
 *   MINITUI_QUEUE_BIN       queue binary with the task-graph feature (default: resolved rust agent)
 *   MINITUI_QUEUE_EMBED_DIR MiniLM directory; when set, chat tasks are embedded
 *   MINITUI_QUEUE_POLL_MS   queue event poll interval (default 5000)
 *   MINITUI_QUEUE_RECONCILE_TIMEOUT_S  wait for an interrupted worker before retry (default 180)
 *   MINITUI_QUEUE_RECONCILE_SETTLE_S   hold after the interrupt event before retry (default 30)
 *
 * Media / transcription (WA-4, all optional):
 *   EVO_MEDIA_DIR                media store (default ~/.local/share/mini-tui/media, 0700)
 *   EVO_MEDIA_MAX_BYTES          per-file download cap (default 20 MB)
 *   EVO_MEDIA_DIR_MAX_BYTES      total store cap, enforced on write + sweep (default 256 MB)
 *   EVO_MEDIA_RETAIN_DAYS        expiry for stored media (default 7)
 *   EVO_MEDIA_TIMEOUT_MS         media fetch timeout (default 30000)
 *   EVO_TRANSCRIBE_BIN           whisper-cli path (default ~/tools/whisper.cpp/build/bin/whisper-cli)
 *   EVO_TRANSCRIBE_MODEL         ggml model path (default ~/tools/whisper.cpp/models/ggml-small.bin)
 *   EVO_TRANSCRIBE_CPU_QUOTA     systemd scope CPUQuota per whisper run (default 25%; empty = no wrapper)
 *   EVO_TRANSCRIBE_MEM_MAX       systemd scope MemoryMax (default 2G)
 *   EVO_TRANSCRIBE_MAX_AUDIO_S   audio duration cap (default 600)
 *   EVO_TRANSCRIBE_TIMEOUT_S     whole-transcription timeout (default 300)
 *   EVO_LATE_SWEEP_MS            late-transcript/media sweep interval (default 600000)
 */

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ChannelInbox } from "./inbox";
import { SendLedger, createEvoSender } from "./evoSend";
import { parseConsumerAccounts } from "./accounts";
import { createEvoMediaClient, MediaStore } from "./evoMedia";
import { createWhisperTranscriber } from "./transcribe";
import { LateTranscriptLog, type MediaHandling } from "./mediaTurn";
import { startChannelConsumer } from "./consumer";
import { QueueBridge } from "./queueBridge";
import { planGroupCreation as planGroupCreationFlow } from "./groupBridge";
import { planSessionCommand } from "./sessionCommand";
import { openDb } from "../sessions";

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
// WA-5 multichat: EVO_ACCOUNTS is a JSON array (one identity per instance);
// absent, the WA-2 single-account env trio still configures exactly one.
const accounts = parseConsumerAccounts();
if (!accounts.length) {
  console.error("consumer: no evo accounts configured (set EVO_ACCOUNTS or EVO_INSTANCE + EVO_INSTANCE_TOKEN)");
  process.exit(2);
}
const senders = new Map(accounts.map((account) => [account.account, createEvoSender({
  baseUrl: required("EVO_API_URL"),
  instance: account.instance,
  token: account.token,
  timeoutMs: Number(process.env.EVO_SEND_TIMEOUT_MS ?? 20_000),
})]));
const defaultAccount = accounts[0]!;
const sender = senders.get(defaultAccount.account)!;
const accountJids = new Map(accounts.map((account) => [account.account, account.jid]));
// Attachment handling (WA-4): enabled when a whisper binary is present. Every
// bound is explicit; the media store's cleanup is owned by this consumer.
// Numeric envs are validated: a garbage value falls back to the default rather
// than becoming NaN (which would silently disable every cap comparison).
const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const mediaDir = process.env.EVO_MEDIA_DIR ?? join(homedir(), ".local/share/mini-tui/media");
const mediaMaxBytes = num(process.env.EVO_MEDIA_MAX_BYTES, 20 * 1024 * 1024);
const retainDays = num(process.env.EVO_MEDIA_RETAIN_DAYS, 7);
const whisperBin = process.env.EVO_TRANSCRIBE_BIN ?? join(homedir(), "tools/whisper.cpp/build/bin/whisper-cli");
const whisperModel = process.env.EVO_TRANSCRIBE_MODEL ?? join(homedir(), "tools/whisper.cpp/models/ggml-small.bin");
const mediaEnabled = existsSync(whisperBin) && existsSync(whisperModel);
if (!mediaEnabled) console.error("consumer: transcription disabled (whisper binary or model missing); voice notes stay pending and are answered honestly");
const media: MediaHandling | undefined = mediaEnabled
  ? {
      client: createEvoMediaClient({
        baseUrl: process.env.EVO_API_URL!,
        instance: process.env.EVO_INSTANCE!,
        token: process.env.EVO_INSTANCE_TOKEN!,
        timeoutMs: num(process.env.EVO_MEDIA_TIMEOUT_MS, 30_000),
        maxBytes: mediaMaxBytes,
      }),
      store: new MediaStore(mediaDir, { maxDirBytes: num(process.env.EVO_MEDIA_DIR_MAX_BYTES, 256 * 1024 * 1024), retainMs: retainDays * 24 * 60 * 60 * 1000 }),
      transcriber: createWhisperTranscriber({
        bin: whisperBin,
        model: whisperModel,
        cpuQuota: /^\d+%$/.test(process.env.EVO_TRANSCRIBE_CPU_QUOTA ?? "") ? (process.env.EVO_TRANSCRIBE_CPU_QUOTA as string) : "25%",
        memMax: /^\d+[GMK]?$/.test(process.env.EVO_TRANSCRIBE_MEM_MAX ?? "") ? (process.env.EVO_TRANSCRIBE_MEM_MAX as string) : "2G",
      }),
      maxAudioSeconds: num(process.env.EVO_TRANSCRIBE_MAX_AUDIO_S, 600),
      transcribeTimeoutMs: num(process.env.EVO_TRANSCRIBE_TIMEOUT_S, 300) * 1000,
      lateSweepMs: num(process.env.EVO_LATE_SWEEP_MS, 600_000),
    }
  : undefined;
const turnTimeoutS = Number(process.env.EVO_CONSUMER_TURN_TIMEOUT_S ?? 600);

const log = (event: string, fields: Record<string, unknown> = {}): void => {
  // Structured, journal-friendly; the token never appears in any field.
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" && /[\s="]/.test(v) ? JSON.stringify(v) : v}`);
  console.log(`[mini-channel-consumer] ${event}${parts.length ? " " + parts.join(" ") : ""}`);
};

// Optional read-only handle on the shared sessions store (queue-task cwd lookup).
const sessionsDb = process.env.MINITUI_DB_PATH ? openDb(process.env.MINITUI_DB_PATH) : undefined;
const queueBridge = new QueueBridge({
  db: inbox.db,
  sender,
  senderFor: (account) => senders.get(account),
  consumer: "queue-events",
  sessionsDb,
  queueBin: process.env.MINITUI_QUEUE_BIN || undefined,
  embedDir: process.env.MINITUI_QUEUE_EMBED_DIR || undefined,
  cwd: process.env.EVO_CONSUMER_CWD,
  pollMs: Number(process.env.MINITUI_QUEUE_POLL_MS ?? 5_000),
  reconcileTimeoutS: Number(process.env.MINITUI_QUEUE_RECONCILE_TIMEOUT_S ?? 180),
  reconcileSettleMs: Number(process.env.MINITUI_QUEUE_RECONCILE_SETTLE_S ?? 30) * 1000,
  log,
});
// Group-session flow (WA-5 + v4-H): one configuration serves both triggers —
// the model's [[mini-newgroup: …]] directive and the operator's `/newsession`
// chat command. The photo is the session's squishmoji avatar; the static
// bizbots mascot frame is the fallback.
const groupBridgeOptions = {
  inbox,
  accountFor: (account: string) => {
    const entry = accounts.find((a) => a.account === account);
    return entry ? { instance: entry.instance, token: entry.token } : undefined;
  },
  baseUrl: process.env.EVO_API_URL ?? "",
  photoPath: process.env.EVO_GROUP_PHOTO || undefined,
  newSessionId: (account: string) => `wa-${account}-${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
  senderFor: (account: string) => senders.get(account),
  // WhatsApp group-create refuses @lid participants (400 bad-request); the
  // account's own trusted jid forms (EVO_ACCOUNTS `jid`) carry the LID↔phone
  // pair, so the operator's LID resolves to their phone jid for the API call.
  // Unresolvable jids pass through unchanged and fail the creation honestly.
  resolveParticipant: (jid: string) => {
    if (!jid.endsWith("@lid")) return jid;
    const bare = jid.replace(/:.*/, "").toLowerCase();
    for (const account of accounts) {
      const forms = (account.jid ?? "").split(",").map((f) => f.trim()).filter(Boolean);
      if (forms.some((f) => f.replace(/:.*/, "").toLowerCase() === bare)) {
        const phone = forms.find((f) => f.endsWith("@s.whatsapp.net"));
        if (phone) return phone;
      }
    }
    return jid;
  },
  log,
};
const { done, stop } = startChannelConsumer({
  inbox,
  sender,
  senderFor: (account) => senders.get(account),
  accountJids,
  planGroupCreation: (row, message, replyText) => planGroupCreationFlow(groupBridgeOptions, row, message, replyText),
  planSessionCommand: (row, message) => planSessionCommand(groupBridgeOptions, row, message),
  ledger: new SendLedger(inbox.db),
  consumer: required("EVO_CONSUMER_NAME"),
  sessionsDbPath: process.env.MINITUI_DB_PATH,
  cwd: process.env.EVO_CONSUMER_CWD,
  model: process.env.MINITUI_MODEL ?? "",
  turnTimeoutS: Number.isFinite(turnTimeoutS) && turnTimeoutS > 0 ? turnTimeoutS : 600,
  queueBridge,
  media,
  lateTranscripts: media ? new LateTranscriptLog(inbox.db) : undefined,
  log,
});
queueBridge.start();
const stopAll = () => {
  queueBridge.stop();
  stop();
};
process.on("SIGINT", () => stopAll());
process.on("SIGTERM", () => stopAll());
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
