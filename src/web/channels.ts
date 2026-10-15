/**
 * Read-only channel visibility for the web panel: what the WhatsApp/Gmail inbox
 * store holds (bindings, recent accepted messages, consumer cursors) and the
 * assistant instance's connection state — including the pairing QR — fetched
 * strictly over loopback from the weai-mini API. Nothing here writes: the
 * inbox store is opened read-only, and the weai API is only ever read.
 *
 * Secrets never cross this module's outputs: the apikey lives in the service
 * environment (or a 0600 env file) and is sent only to the loopback weai API,
 * never logged, never proxied, never included in a response. Message bodies
 * are truncated to a display bound; the raw payload is never returned.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TEXT_MAX = 800;
const MESSAGES_MAX = 20;
const QR_MAX_BYTES = 200_000;
/** The weai connect endpoint regenerates the QR every call (~60 s TTL). */
const QR_MIN_INTERVAL_MS = 5_000;
const QR_TTL_MS = 60_000;
/** The pairing code lives about a minute (WhatsApp-side), like the QR. */
const CODE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

export interface ChannelsAttachmentView {
  id: string;
  kind: string;
  mime: string | null;
  transcriptionState: string | null;
  transcript: string | null;
}
export interface ChannelsMessageView {
  seq: number;
  channel: string;
  account: string;
  thread: string;
  sender: string;
  messageId: string;
  sentAt: number;
  receivedAt: number;
  session: string;
  project: string;
  replyTo: string | null;
  text: string;
  truncated: boolean;
  attachments: ChannelsAttachmentView[];
}
export interface ChannelsBindingView {
  channel: string;
  account: string;
  thread: string;
  session: string;
  project: string;
  allowedSenders: string[];
}
export interface ChannelsConsumerView {
  consumer: string;
  cursor: number;
  /** Accepted messages not yet acknowledged by this consumer. */
  lag: number;
}
export interface ChannelsView {
  configured: boolean;
  bindings: ChannelsBindingView[];
  messages: ChannelsMessageView[];
  consumers: ChannelsConsumerView[];
  lastSeq: number;
}

/** Display truncation: the panel shows bounded text, never the full payload. */
function display(text: string, max = TEXT_MAX): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

function inboxPath(): string {
  return process.env.EVO_INBOX_DB ?? join(homedir(), ".local/share/mini-tui/channels.sqlite");
}

function parsePayload(raw: string): { text?: string; replyTo?: string; attachments?: Array<Record<string, unknown>> } {
  try {
    const value = JSON.parse(raw) as { text?: unknown; replyTo?: unknown; attachments?: unknown };
    return {
      text: typeof value.text === "string" ? value.text : "",
      replyTo: typeof value.replyTo === "string" ? value.replyTo : undefined,
      attachments: Array.isArray(value.attachments) ? (value.attachments as Array<Record<string, unknown>>).slice(0, 16) : [],
    };
  } catch {
    return {};
  }
}

/** Open the shared channel store read-only; a missing file simply means "not configured". */
export async function channelsView(): Promise<ChannelsView> {
  const path = inboxPath();
  if (!existsSync(path)) return { configured: false, bindings: [], messages: [], consumers: [], lastSeq: 0 };
  const db = new Database(path, { readonly: true, create: false });
  let lastSeq = 0;
  try {
    const table = (name: string) => {
      try {
        db.query(`SELECT 1 FROM ${name} LIMIT 1`).get();
        return true;
      } catch {
        return false;
      }
    };
    const bindings: ChannelsBindingView[] = [];
    if (table("channel_bindings")) {
      const rows = db.query(`SELECT channel,account,thread,session,project,allowed_senders FROM channel_bindings ORDER BY channel,account,thread LIMIT 1000`).all() as Array<{
        channel: string; account: string; thread: string; session: string; project: string; allowed_senders: string;
      }>;
      for (const row of rows) {
        let senders: string[] = [];
        try {
          const parsed = JSON.parse(row.allowed_senders) as unknown;
          if (Array.isArray(parsed)) senders = parsed.filter((s): s is string => typeof s === "string").slice(0, 100);
        } catch { /* a malformed allowlist is shown as empty, never guessed */ }
        bindings.push({ channel: row.channel, account: row.account, thread: row.thread, session: row.session, project: row.project, allowedSenders: senders });
      }
    }
    const messages: ChannelsMessageView[] = [];
    if (table("channel_inbox")) {
      const last = db.query(`SELECT COALESCE(MAX(seq),0) AS seq FROM channel_inbox`).get() as { seq: number };
      const rows = db.query(`SELECT seq,channel,account,thread,message_id,sender,sent_at,received_at,session,project,payload FROM channel_inbox ORDER BY seq DESC LIMIT ?1`).all(MESSAGES_MAX) as Array<{
        seq: number; channel: string; account: string; thread: string; message_id: string; sender: string;
        sent_at: number; received_at: number; session: string; project: string; payload: string;
      }>;
      for (const row of rows) {
        const payload = parsePayload(row.payload);
        const body = display(payload.text ?? "");
        messages.push({
          seq: row.seq, channel: row.channel, account: row.account, thread: row.thread,
          sender: row.sender, messageId: row.message_id, sentAt: row.sent_at, receivedAt: row.received_at,
          session: row.session, project: row.project, replyTo: payload.replyTo ?? null,
          text: body.text, truncated: body.truncated,
          attachments: (payload.attachments ?? []).map(a => {
            const transcript = typeof a.transcript === "string" ? a.transcript : null;
            const shown = transcript === null ? null : display(transcript, 400);
            return {
              id: typeof a.id === "string" ? a.id : "",
              kind: typeof a.kind === "string" ? a.kind : "document",
              mime: typeof a.mime === "string" ? a.mime : null,
              transcriptionState: typeof a.transcriptionState === "string" ? a.transcriptionState : null,
              transcript: shown === null ? null : shown.text,
            };
          }),
        });
      }
      lastSeq = Number(last.seq);
    }
    const consumers: ChannelsConsumerView[] = [];
    if (table("channel_consumers") && table("channel_inbox")) {
      const rows = db.query(`SELECT c.consumer,c.cursor,(SELECT COALESCE(MAX(seq),0) FROM channel_inbox) AS newest FROM channel_consumers c ORDER BY c.consumer LIMIT 100`).all() as Array<{ consumer: string; cursor: number; newest: number }>;
      for (const row of rows) consumers.push({ consumer: row.consumer, cursor: row.cursor, lag: Math.max(0, Number(row.newest) - Number(row.cursor)) });
    }
    return { configured: true, bindings, messages, consumers, lastSeq: typeof lastSeq === "number" ? lastSeq : 0 };
  } finally {
    db.close();
  }
}

// --- weai-mini connection visibility (loopback only) ---

export interface EvoStatusView {
  configured: boolean;
  instance?: string;
  state?: "connected" | "connecting" | "qr" | "disconnected" | "unreachable";
  detail?: string;
}
export interface EvoQrView {
  configured: boolean;
  state?: EvoStatusView["state"];
  qr?: string;
  code?: string;
  expiresAt?: number;
  error?: string;
}

export interface EvoPairView {
  configured: boolean;
  state?: EvoStatusView["state"];
  code?: string;
  expiresAt?: number;
  error?: string;
}

interface EvoConfig {
  baseUrl: string;
  instance: string;
  apiKey: string;
}

function envValue(name: string): string {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : "";
}

/** The apikey comes from the service environment (systemd EnvironmentFile) or a 0600 env file — never the repo, never the client. */
function evoConfig(): EvoConfig | null {
  const instance = envValue("EVO_CONNECT_INSTANCE") || envValue("EVO_INSTANCE") || "mini-assistant";
  const baseUrl = (envValue("EVO_CONNECT_BASE_URL") || "http://127.0.0.1:8952").replace(/\/+$/, "");
  let apiKey = envValue("EVO_CONNECT_API_KEY") || envValue("INSTANCE_TOKEN_MINI_ASSISTANT");
  if (!apiKey) {
    const file = envValue("EVO_CONNECT_ENV_FILE") || "/etc/evo-weai/mini.env";
    const keyName = envValue("EVO_CONNECT_API_KEY_NAME") || "INSTANCE_TOKEN_MINI_ASSISTANT";
    try {
      if (existsSync(file)) {
        for (const line of readFileSync(file, "utf8").split("\n")) {
          const match = line.match(/^[A-Za-z_][A-Za-z0-9_]*=(.*)$/);
          if (match && line.slice(0, line.indexOf("=")) === keyName) {
            apiKey = match[1]!.trim().replace(/^["']|["']$/g, "");
            break;
          }
        }
      }
    } catch { /* unreadable key file: report unconfigured, never fall back to guessing */ }
  }
  if (!apiKey) return null;
  // Fail closed: this proxy exists for the loopback weai-mini API only.
  let host = "";
  try { host = new URL(baseUrl).hostname; } catch { return null; }
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return null;
  return { baseUrl, instance, apiKey };
}

async function weaiGet(pathname: string, config: EvoConfig): Promise<Record<string, unknown> | null> {
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  const abort = new AbortController();
  try {
    const response = await fetch(`${config.baseUrl}${pathname}`, {
      headers: { apikey: config.apiKey },
      signal: abort.signal,
    });
    if (response.status !== 200) return null;
    return await response.json() as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function mapState(raw: string): EvoStatusView["state"] {
  const value = raw.toLowerCase();
  if (value === "open") return "connected";
  if (value === "connecting") return "connecting";
  if (value === "close" || value === "closed") return "disconnected";
  return "disconnected";
}

/** weai 0.2.8 nests the instance: {"instance":{"instanceName","state"}}; older builds answered flat. */
function rawState(data: Record<string, unknown>): string {
  if (typeof data.state === "string") return data.state;
  if (typeof data.connectionStatus === "string") return data.connectionStatus;
  const nested = data.instance;
  if (nested && typeof nested === "object") {
    const inner = nested as Record<string, unknown>;
    if (typeof inner.state === "string") return inner.state;
    if (typeof inner.connectionStatus === "string") return inner.connectionStatus;
  }
  return "";
}

export async function evoStatus(): Promise<EvoStatusView> {
  const config = evoConfig();
  if (!config) return { configured: false };
  const data = await weaiGet(`/instance/connectionState/${encodeURIComponent(config.instance)}`, config);
  if (!data) return { configured: true, instance: config.instance, state: "unreachable", detail: "weai-mini did not answer on loopback" };
  return { configured: true, instance: config.instance, state: mapState(rawState(data)) };
}

let lastQrAt = 0;

/** The QR is regenerated by every connect call and expires in ~60 s: the client shows a refresh button. */
export async function evoQr(): Promise<EvoQrView> {
  const config = evoConfig();
  if (!config) return { configured: false, error: "evo connect not configured" };
  if (Date.now() - lastQrAt < QR_MIN_INTERVAL_MS) return { configured: true, error: "qr_rate_limited", expiresAt: lastQrAt + QR_TTL_MS };
  lastQrAt = Date.now();
  const data = await weaiGet(`/instance/connect/${encodeURIComponent(config.instance)}`, config);
  if (!data) return { configured: true, state: "unreachable", error: "weai-mini did not answer on loopback" };
  const qr = typeof data.base64 === "string" && data.base64.startsWith("data:") && data.base64.length <= QR_MAX_BYTES ? data.base64 : undefined;
  const code = typeof data.code === "string" && data.code.length <= 64 ? data.code : undefined;
  if (!qr && !code) {
    // A connected instance has no QR to offer; say so instead of inventing one.
    const status = await evoStatus();
    return { configured: true, state: status.state === "unreachable" ? undefined : status.state, error: qr === undefined && code === undefined && status.state === "connected" ? "already_connected" : "no_qr_available" };
  }
  return { configured: true, qr, code, expiresAt: Date.now() + QR_TTL_MS };
}

/** Same shape weai's own normalize_number accepts: digits with optional separators, 7–15 long, no leading 0. */
export function normalizePairingNumber(raw: string): string | null {
  let digits = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c >= "0" && c <= "9") digits += c;
    else if ((c === "+" && i === 0) || c === " " || c === "-" || c === "." || c === "(" || c === ")") continue;
    else return null;
  }
  return digits.length >= 7 && digits.length <= 15 && !digits.startsWith("0") ? digits : null;
}

/** A Baileys pairing code: uppercase alphanumerics, optionally dashed ("ABCD-WXYZ"). */
function pairingCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z0-9]{4,8}(-[A-Z0-9]{4})?$/.test(value) ? value : undefined;
}

let lastCodeAt = 0;

/** Test hook: the 5 s pairing rate limit is module state. */
export function resetPairingRateLimit(): void {
  lastCodeAt = 0;
}

/**
 * Pairing by code: asks weai for a connect with the phone number and returns
 * the short code the user types on the phone. Like the QR, every upstream
 * call restarts a login, so calls are rate-limited (5 s) and a code already
 * live on the socket is answered as is — the same code, not a new one.
 */
export async function evoPairingCode(rawNumber: string): Promise<EvoPairView> {
  const digits = normalizePairingNumber(rawNumber);
  if (!digits) return { configured: true, error: "invalid_number" };
  const config = evoConfig();
  if (!config) return { configured: false, error: "evo connect not configured" };
  if (Date.now() - lastCodeAt < QR_MIN_INTERVAL_MS) return { configured: true, error: "code_rate_limited", expiresAt: lastCodeAt + CODE_TTL_MS };
  lastCodeAt = Date.now();
  const data = await weaiGet(`/instance/connect/${encodeURIComponent(config.instance)}?number=${digits}`, config);
  if (!data) return { configured: true, state: "unreachable", error: "weai-mini did not answer on loopback" };
  const raw = rawState(data);
  if (raw.toLowerCase() === "open") return { configured: true, state: "connected", error: "already_connected" };
  const code = pairingCode(data.pairingCode);
  if (!code) {
    // No code on the socket within the wait window: report the state we see
    // instead of inventing one (a connecting instance may still emit one).
    const status = await evoStatus();
    return { configured: true, state: status.state === "unreachable" ? undefined : status.state, error: "no_code_available" };
  }
  return { configured: true, code, expiresAt: Date.now() + CODE_TTL_MS };
}
