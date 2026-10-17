/**
 * Who a WhatsApp sender READS as.
 *
 * The provider sends both halves of an identity: the jid (`key.participant`, a
 * stable 15-digit LID) and the name the sender chose for themselves
 * (`pushName`, from the stanza's `notify` attribute). Only the jid was kept,
 * so every reader of a mirrored message — a person on the web, a screen reader,
 * and the agent's own prompt — saw a bare number where a name belonged.
 *
 * The rule, in one place so the web and the agent cannot diverge:
 *
 *  - the NAME is display only. It is never identity: `sender` (the jid) is
 *    what the binding's `allowedSenders` compares, so a name can neither
 *    grant a turn nor appear in one.
 *  - a name is only a name if it is non-empty, has no control characters and
 *    fits a header. Anything else falls back to the jid, so a hostile or
 *    broken delivery renders the number rather than nothing at all.
 *  - the fallback keeps the jid's domain stripped (`242554100576489@lid` →
 *    `242554100576489`): the domain is transport routing, not identity either.
 */

/** Above this a "name" is a paragraph; below, it is a header. */
export const NAME_MAX = 64;
/** A name longer than this in bytes is not a name, it is an attack. */
const MAX_BYTES = 512;

/**
 * The name a sender chose, when it is usable as one. Returns null for every
 * shape that must not reach a reader as a name: absent, empty/whitespace, or
 * carrying control characters (which would break a line or smuggle a newline
 * into the agent's prompt).
 */
export function cleanSenderName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // An over-long "name" is TRUNCATED, not refused: it is a label, and a label
  // too long for a header is still a label. Refusing it would drop the name
  // exactly when the sender chose a long one, and the reader would be back to
  // the number. The hard byte cap is a backstop against an absurd payload.
  if (Buffer.byteLength(trimmed) > MAX_BYTES) return null;
  return trimmed.length > NAME_MAX ? trimmed.slice(0, NAME_MAX) : trimmed;
}

/**
 * What to show for a sender: their name when the delivery carried one, else the
 * jid without its routing domain. Never empty — an unnamed sender still needs
 * to be attributable.
 */
export function senderDisplayName(jid: string, raw?: unknown): string {
  const name = cleanSenderName(raw);
  if (name) return name;
  const local = jid.replace(/@.*$/, "");
  return local || jid.slice(0, NAME_MAX);
}
