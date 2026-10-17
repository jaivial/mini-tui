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
 *
 * Immediate ack (v5-E, all optional — the reaction goes out on acceptance and
 * the MODEL-written one-liner follows only if the turn outruns the timer):
 *   EVO_ACK_REACTION         emoji sent on acceptance ("" mutes it; default 👀)
 *   EVO_ACK_DELAY_MS         how long the turn may run before that line (4000)
 *   EVO_ACK_MODEL            model that writes the line (default MINITUI_MODEL)
 *   EVO_ACK_MODEL_TIMEOUT_MS ceiling on that model call (6000)
 *   EVO_ACK_MAX_TOKENS       token cap for that call (60)
 *   A per-binding override lives in channel_bindings.ack (see bindingsCli ack);
 *   what was generated and whether it was sent is in channel_acks.
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
 *   EVO_TRANSCRIBE_LANG          pin the decode language (default "es"; empty = whisper auto-detects)
 *   EVO_TRANSCRIBE_CPU_QUOTA     systemd scope CPUQuota per whisper run (default 25%; empty = no wrapper)
 *   EVO_TRANSCRIBE_MEM_MAX       systemd scope MemoryMax (default 2G)
 *   EVO_TRANSCRIBE_MAX_AUDIO_S   audio duration cap (default 600)
 *   EVO_TRANSCRIBE_TIMEOUT_S     whole-transcription timeout (default 300)
 *   EVO_LATE_SWEEP_MS            late-transcript/media sweep interval (default 600000)
 *
 * v6-E — "escribiendo…", semantic reactions and outgoing voice notes (all
 * optional; each defaults to ON with a conservative bound):
 *   EVO_TYPING=0                 disables the presence calls entirely
 *   EVO_TYPING_DELAY_MS          server-side presence expiry (default 30000)
 *   EVO_TYPING_REFRESH_MS        re-arm cadence for long turns (default 15000)
 *   EVO_TYPING_TIMEOUT_MS        per-call timeout (default 2500)
 *   EVO_TYPING_THREADS           comma list of threads to skip (default empty = all)
 *   EVO_SEMANTIC_REACTIONS=0     keep the fixed acceptance emoji instead
 *   EVO_VOICE_DIRS               comma list of dirs a [[mini-voice: path]] may
 *                                attach from (default ~/.local/share/mini-tui/voice)
 *   EVO_VOICE_MAX_BYTES          per-note cap (default 5 MB)
 *
 * NOTE the systemd lane: the consumer is a SYSTEM unit, so `systemd-run --user`
 * (the cgroup wrapper transcribe.ts uses) only resolves when XDG_RUNTIME_DIR is
 * exported. The unit sets it; without it every whisper run fails to spawn the
 * scope and transcription degrades to "temporarily unavailable".
 */

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ChannelInbox } from "./inbox";
import { SendLedger, createEvoSender } from "./evoSend";
import { AckLedger, DEFAULT_ACK } from "./ack";
import { parseConsumerAccounts } from "./accounts";
import { createEvoMediaClient, MediaStore } from "./evoMedia";
import { createWhisperTranscriber } from "./transcribe";
import { LateTranscriptLog, type MediaHandling } from "./mediaTurn";
import { startChannelConsumer } from "./consumer";
import { planImageMarkers, planVoiceMarkers } from "./consumer";
import { MirrorStore, type MirrorAttachment } from "./mirror";
import { QueueBridge } from "./queueBridge";
import { planGroupCreation as planGroupCreationFlow, setGroupSubject } from "./groupBridge";
import { planSessionCommand } from "./sessionCommand";
import { planRenameCommand } from "./renameCommand";
import { planRouterCommand } from "./routerCommand";
import { generateTitle } from "../title";
import { startControlGroupWatcher } from "./controlGroup";
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
        language: process.env.EVO_TRANSCRIBE_LANG ?? "es",
        cpuQuota: /^\d+%$/.test(process.env.EVO_TRANSCRIBE_CPU_QUOTA ?? "") ? (process.env.EVO_TRANSCRIBE_CPU_QUOTA as string) : "25%",
        memMax: /^\d+[GMK]?$/.test(process.env.EVO_TRANSCRIBE_MEM_MAX ?? "") ? (process.env.EVO_TRANSCRIBE_MEM_MAX as string) : "2G",
      }),
      maxAudioSeconds: num(process.env.EVO_TRANSCRIBE_MAX_AUDIO_S, 600),
      transcribeTimeoutMs: num(process.env.EVO_TRANSCRIBE_TIMEOUT_S, 300) * 1000,
      lateSweepMs: num(process.env.EVO_LATE_SWEEP_MS, 600_000),
    }
  : undefined;
const turnTimeoutS = Number(process.env.EVO_CONSUMER_TURN_TIMEOUT_S ?? 600);

// v6-E: where a [[mini-voice: path]] may point. An explicit allowlist — the
// default is a dedicated dir the TTS step writes into, so a model can only ever
// attach audio this stack produced. A malformed list is an empty list (nothing
// deliverable), never a silently-widened one.
const voiceDirs = (process.env.EVO_VOICE_DIRS ?? join(homedir(), ".local/share/mini-tui/voice"))
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

// Espejo (WhatsApp → web): messages the consumer acks WITHOUT a turn are
// recorded for the bound session's web transcript. Turn-generating messages
// reach the web through the session journal and are NOT mirrored (the web
// would show them twice). Media rides along best-effort: an image or document
// whose bytes are here is rendered by the web; one that fails to fetch is
// still mirrored, as metadata only.
const mirror = new MirrorStore(inbox.db);
const mirrorIn = async (row: { seq: number; account: string; thread: string; session: string }, message: { messageId: string; sender: string; senderName?: string; sentAt: number; text: string; attachments: Array<{ id: string; kind: "image" | "audio" | "document"; mime?: string; providerRef?: string }> }): Promise<void> => {
  const handling = media;
  const attachments: MirrorAttachment[] = [];
  for (const attachment of message.attachments) {
    let path: string | null = handling ? handling.store?.find(row.seq, attachment.id) ?? null : null;
    if (!path && attachment.providerRef && attachment.kind !== "audio" && handling?.store && handling.client) {
      try {
        const fetched = await handling.client.fetchMedia({ providerRef: attachment.providerRef, thread: row.thread });
        path = handling.store.save(row.seq, attachment.id, fetched.bytes, fetched.mime ?? attachment.mime ?? null);
      } catch (error) {
        log("channel.mirror.media", { seq: row.seq, attachmentId: attachment.id, error: error instanceof Error ? error.message.slice(0, 160) : String(error) });
      }
    }
    attachments.push({ id: attachment.id, kind: attachment.kind, mime: attachment.mime ?? null, path });
  }
  const id = mirror.append({
    inboxSeq: row.seq,
    session: row.session,
    channel: "whatsapp",
    account: row.account,
    thread: row.thread,
    messageId: message.messageId,
    sender: message.sender,
    senderName: message.senderName,
    sentAt: message.sentAt,
    text: message.text,
    attachments,
  });
  if (id) log("channel.mirror.appended", { seq: row.seq, session: row.session, mirrorId: id });
};

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
  mirrorIn,
  planGroupCreation: (row, message, replyText) => planGroupCreationFlow(groupBridgeOptions, row, message, replyText),
  planSessionCommand: (row, message) => planSessionCommand(groupBridgeOptions, row, message),
  planRenameCommand: (row, message) => planRenameCommand({ ...groupBridgeOptions, sessionsDbPath: process.env.MINITUI_DB_PATH }, row, message),
  // v6-C: the same toggle the Settings panel writes, driven from a thread.
  planRouterCommand: (row, message) => planRouterCommand(groupBridgeOptions, row, message),
  // v5-A: a fresh session's first message names it — AI title best-effort, and
  // a bound group wears it as its subject. Same generation helper as the web.
  generateSessionTitle: (task, model, onTitle) => generateTitle(task, model, onTitle),
  renameGroupSubject: (account, groupJid, subject) => {
    const entry = groupBridgeOptions.accountFor(account);
    if (!entry) return Promise.resolve();
    return setGroupSubject(groupBridgeOptions.baseUrl, entry.instance, entry.token, groupJid, subject).then((result) => {
      if (!result.ok) throw new Error(result.error || `status ${result.status}`);
    });
  },
  // v6-E: "escribiendo…" presence. On by default with a conservative server-side
  // expiry (30s) and a re-arm at 15s so a long turn never blinks off, and every
  // exit path clears it. EVO_TYPING=0 turns the feature off outright.
  typing: process.env.EVO_TYPING === "0" ? undefined : {
    delayMs: num(process.env.EVO_TYPING_DELAY_MS, 30_000),
    refreshMs: num(process.env.EVO_TYPING_REFRESH_MS, 15_000),
    timeoutMs: num(process.env.EVO_TYPING_TIMEOUT_MS, 2_500),
    enabled: true,
  },
  // v6-E: the acceptance emoji comes from the sender's words when they carry a
  // signal, and stays the configured 👀 when they do not. EVO_SEMANTIC_REACTIONS=0
  // restores the fixed emoji.
  semanticReactions: process.env.EVO_SEMANTIC_REACTIONS !== "0",
  // v4-F: [[mini-image: <path>]] markers become WhatsApp media. Only paths the
  // computer_use pool itself wrote are deliverable (validation inside).
  planImages: (row, message, replyText) => planImageMarkers(replyText, process.env.MINITUI_CU_POOL_DIR || join(homedir(), ".local/share/mini-tui/cu-pool")),
  // v6-E: [[mini-voice: <path>]] markers become real WhatsApp voice notes. Only
  // paths under the configured voice dir(s) are deliverable, and only audio.
  planVoices: (row, message, replyText) => planVoiceMarkers(replyText, voiceDirs),
  ledger: new SendLedger(inbox.db),
  // v5-E: the immediate ack. The reaction and the model's one-liner go out
  // while the turn runs; the 4s timer only decides whether the line is sent.
  // Every knob is an env override of a sensible default, and EVO_ACK_REACTION=""
  // disables the reaction without touching the rest.
  ackLedger: new AckLedger(inbox.db),
  ackConfig: {
    ...DEFAULT_ACK,
    reaction: process.env.EVO_ACK_REACTION ?? DEFAULT_ACK.reaction,
    delayMs: num(process.env.EVO_ACK_DELAY_MS, DEFAULT_ACK.delayMs),
    modelTimeoutMs: num(process.env.EVO_ACK_MODEL_TIMEOUT_MS, DEFAULT_ACK.modelTimeoutMs),
    maxTokens: num(process.env.EVO_ACK_MAX_TOKENS, DEFAULT_ACK.maxTokens),
    escalations: Number.isFinite(Number(process.env.EVO_ACK_ESCALATIONS)) && Number(process.env.EVO_ACK_ESCALATIONS) >= 0
      ? Math.min(3, Math.floor(Number(process.env.EVO_ACK_ESCALATIONS)))
      : DEFAULT_ACK.escalations,
  },
  ackModel: process.env.EVO_ACK_MODEL || process.env.MINITUI_MODEL || "",
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
// Control group on connect (v4-H): poll each account's instance state and, on
// the transition to connected, guarantee ONE bound command channel — same
// create → avatar → bind flow as /newsession, policy "all", allowlist = the
// owner's trusted jid forms, announced in the group. Idempotent forever: one
// durable marker row per account (channel_control_groups), so re-connects and
// restarts never duplicate groups. A disabled watcher is a no-op (EVO_CONTROL_GROUP_POLL_MS=0).
const controlGroupPollMs = Number(process.env.EVO_CONTROL_GROUP_POLL_MS ?? 30_000);
const controlGroup = Number.isFinite(controlGroupPollMs) && controlGroupPollMs > 0
  ? startControlGroupWatcher({
      inbox,
      baseUrl: process.env.EVO_API_URL ?? "",
      bridge: groupBridgeOptions,
      pollMs: controlGroupPollMs,
      accounts: accounts.map((account) => ({
        account: account.account,
        instance: account.instance,
        token: account.token,
        ownerJids: (account.jid ?? "").split(",").map((jid) => jid.trim()).filter(Boolean),
      })),
      log,
    })
  : undefined;
const stopAll = () => {
  controlGroup?.stop();
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
