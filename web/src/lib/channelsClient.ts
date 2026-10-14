/**
 * Read-only channel visibility client for the panel: the inbox projection
 * (bindings, recent accepted messages, consumer cursors) and the assistant
 * connection view (state + pairing QR). Everything here is a GET the server
 * answers from its own read-only store or a loopback call; the client only
 * renders, it never advances a cursor or touches the channel services.
 *
 * Responses are fail-closed validated: a malformed or oversized projection is
 * refused, never rendered partially.
 */

export interface ChannelsAttachment {
  id: string;
  kind: string;
  mime: string | null;
  transcriptionState: string | null;
  transcript: string | null;
}

export interface ChannelsMessage {
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
  attachments: ChannelsAttachment[];
}

export interface ChannelsBinding {
  channel: string;
  account: string;
  thread: string;
  session: string;
  project: string;
  allowedSenders: string[];
}

export interface ChannelsConsumer {
  consumer: string;
  cursor: number;
  lag: number;
}

export interface ChannelsView {
  configured: boolean;
  bindings: ChannelsBinding[];
  messages: ChannelsMessage[];
  consumers: ChannelsConsumer[];
  lastSeq: number;
}

export type EvoState = "connected" | "connecting" | "qr" | "disconnected" | "unreachable";

export interface EvoStatus {
  configured: boolean;
  instance?: string;
  state?: EvoState;
  detail?: string;
}

export interface EvoQr {
  configured: boolean;
  state?: EvoState;
  qr?: string;
  code?: string;
  expiresAt?: number;
  error?: string;
}

const MAX_MESSAGES = 40;
const MAX_BINDINGS = 200;
const MAX_TEXT = 2_000;

function str(value: unknown, max = 256): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validMessage(value: unknown): value is ChannelsMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  const attachments = m.attachments;
  return int(m.seq) !== null
    && typeof m.channel === "string" && typeof m.thread === "string"
    && typeof m.sender === "string" && typeof m.text === "string" && m.text.length <= MAX_TEXT
    && typeof m.truncated === "boolean" && int(m.sentAt) !== null && int(m.receivedAt) !== null
    && Array.isArray(attachments) && attachments.length <= 16
    && (attachments as unknown[]).every(a => a !== null && typeof a === "object"
      && typeof (a as Record<string, unknown>).id === "string"
      && ((a as Record<string, unknown>).transcript === null || typeof (a as Record<string, unknown>).transcript === "string"));
}

function validView(value: unknown): value is ChannelsView {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.configured !== "boolean" || int(v.lastSeq) === null) return false;
  if (!Array.isArray(v.bindings) || v.bindings.length > MAX_BINDINGS || !Array.isArray(v.messages) || v.messages.length > MAX_MESSAGES) return false;
  if (!Array.isArray(v.consumers) || v.consumers.length > 100) return false;
  return v.messages.every(validMessage)
    && v.bindings.every(b => b !== null && typeof b === "object" && typeof (b as Record<string, unknown>).channel === "string"
      && Array.isArray((b as Record<string, unknown>).allowedSenders))
    && v.consumers.every(c => c !== null && typeof c === "object" && typeof (c as Record<string, unknown>).consumer === "string"
      && int((c as Record<string, unknown>).cursor) !== null && int((c as Record<string, unknown>).lag) !== null);
}

export class ChannelsClient {
  constructor(readonly base = "/api") {}

  async inbox(): Promise<ChannelsView> {
    const res = await fetch(`${this.base}/channels/inbox`);
    if (!res.ok) throw new Error(`channel inbox unavailable (${res.status})`);
    const view = await res.json() as unknown;
    if (!validView(view)) throw new Error("invalid channel projection");
    return view;
  }

  async evoStatus(): Promise<EvoStatus> {
    const res = await fetch(`${this.base}/channels/evo/status`);
    if (!res.ok) throw new Error(`connection status unavailable (${res.status})`);
    const view = await res.json() as EvoStatus;
    if (typeof view?.configured !== "boolean") throw new Error("invalid connection status");
    return view;
  }

  async evoQr(): Promise<EvoQr> {
    const res = await fetch(`${this.base}/channels/evo/qr`);
    const view = await res.json().catch(() => null) as EvoQr | null;
    if (!view || typeof view.configured !== "boolean") throw new Error(`QR unavailable (${res.status})`);
    return view;
  }
}
