import type { Attachment, Inbound } from "./inbox";

/** Decode an already authenticated Evo delivery. Never trust body.instance as the account. */
export function normalizeEvo(payload: unknown, trustedAccount: string): Inbound[] {
  if (!payload || typeof payload !== "object") throw new Error("invalid Evo envelope");
  const envelope = payload as Record<string, unknown>;
  if (envelope.event !== "messages.upsert" && envelope.event !== "MESSAGES_UPSERT") return [];
  const data = Array.isArray(envelope.data) ? envelope.data : [envelope.data];
  if (data.length > 100) throw new Error("Evo batch exceeds100 messages");
  return data.flatMap(raw => {
    if (!raw || typeof raw !== "object") throw new Error("invalid Evo message");
    const item = raw as Record<string, any>;
    const key = item.key;
    if (!key || typeof key.id !== "string" || typeof key.remoteJid !== "string") throw new Error("missing Evo message identity");
    // Sent-device mirrors/API echoes must not start recursive bot work.
    if (key.fromMe === true) return [];
    if (key.fromMe !== false) throw new Error("ambiguous Evo sender direction");
    if (key.remoteJid.endsWith("@g.us") && typeof key.participant !== "string") throw new Error("group message lacks participant identity");
    const sender = key.participant || key.remoteJid;
    if (typeof sender !== "string") throw new Error("missing Evo sender");
    let message = item.message ?? {};
    message = message.ephemeralMessage?.message ?? message;
    message = message.viewOnceMessage?.message ?? message;
    const attachments: Attachment[] = [];
    for (const [field, kind] of [["imageMessage","image"],["audioMessage","audio"],["documentMessage","document"]] as const) {
      const media = message[field];
      if (media) attachments.push({ id: `${key.id}:${field}`, kind, mime: typeof media.mimetype === "string" ? media.mimetype : undefined, providerRef: key.id, transcriptionState: kind === "audio" ? "pending" : undefined });
    }
    const text = message.conversation ?? message.extendedTextMessage?.text ?? message.imageMessage?.caption ?? message.documentMessage?.caption ?? "";
    const timestamp = Number(item.messageTimestamp);
    if (typeof text !== "string" || !Number.isFinite(timestamp) || timestamp < 0) throw new Error("invalid Evo content/time");
    const context = message.extendedTextMessage?.contextInfo ?? message.imageMessage?.contextInfo ?? message.audioMessage?.contextInfo;
    return [{ channel: "whatsapp", account: trustedAccount, thread: key.remoteJid, messageId: key.id, sender, sentAt: Math.trunc(timestamp * 1000), text, replyTo: typeof context?.stanzaId === "string" ? context.stanzaId : undefined, attachments }];
  });
}
