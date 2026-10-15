/**
 * Semantic reactions — the same `sendReaction` the ack already uses, but chosen
 * from WHAT the message says instead of a fixed 👀.
 *
 * Why a vocabulary and not a model call: a reaction is the fastest signal the
 * bot can send (it lands in ~1s, before any turn finishes) and it must never be
 * a bottleneck or a lie. Asking a small model for an emoji costs a round-trip on
 * the hot path and returns either boilerplate or nothing. So the mapping is
 * deterministic, ordered, and inspectable — and the react-to-anything capability
 * (the part that was genuinely missing) is just `reactTo`, which decorates any
 * message id the consumer holds, not only the one it is answering.
 *
 * Honesty rules baked in:
 *  - ONE reaction per message per user. WhatsApp REPLACES your previous
 *    reaction on a message, so sending 👀 (acceptance) and then 👍 (semantic)
 *    would erase the acceptance signal and leave channel_acks claiming a
 *    reaction the sender can no longer see. So the semantic emoji is chosen for
 *    the SAME slot: `pickAckReaction` picks the semantic emoji when one matches
 *    and falls back to the configured acceptance emoji otherwise. One message,
 *    one reaction, one true ledger row.
 *  - `reactTo` is the general capability — decorate ANY message the stack holds,
 *    not only the one being answered. It is opt-in per call site for the same
 *    replacement reason.
 *  - Nothing is inferred from silence: no match means no reaction, never a guess.
 *  - Only emoji WhatsApp actually accepts are in the table; the fork rejects
 *    anything that is not a single emoji or empty string.
 */

import type { EvoSender } from "./evoSend";

/** Emoji the fork's `sendReaction` accepts (it rejects non-emoji strings). */
export type ReactionEmoji =
  | "👍" | "👎" | "🎉" | "❤️" | "😂" | "😅" | "😮" | "🤔" | "🙏" | "👀"
  | "🔥" | "✅" | "❌" | "⏳" | "📌" | "🚀" | "💡" | "☕" | "🤝" | "🫡" | "🎧";

/** Ordered rules: the FIRST match wins, so put the specific before the general. */
interface Rule {
  emoji: ReactionEmoji;
  /** Word-boundary match on the normalized sender text (accent-insensitive). */
  words?: RegExp;
  /** Substring the text must carry for the rule to apply at all. */
  contains?: string;
  /** Only fire in these attachments shapes (undefined = any). */
  when?: (ctx: ReactionContext) => boolean;
}

export interface ReactionContext {
  /** The sender's own words (never the transport frame). */
  text: string;
  /** True when the turn carries a voice note. */
  hasAudio?: boolean;
}

/** Strip accents and lowercase so "GRACIAS" and "gracias" match the same rule. */
export function normalizeForReaction(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const w = (source: string): RegExp => new RegExp(`\\b${source}\\b`);

/** Ordered, most specific first. Every entry must be defensible at a glance. */
const RULES: Rule[] = [
  // A voice note gets a headphone emoji: it says "I heard a voice note" without
  // pretending to know what was in it.
  { emoji: "🎧", when: (c) => c.hasAudio === true },
  { emoji: "🎉", words: w("felicidades|feliz|enhorabuena|congratulations|congrats") },
  { emoji: "🎉", words: w("celebrar|fiesta|cumpleanos") },
  { emoji: "❤️", words: w("gracias|agradezco|te quiero|thanks|thank you") },
  { emoji: "🙏", words: w("por favor|favor|please") },
  // "ok" is deliberately absent: it is the most common word in a chat and a
  // bare "ok" carries no sentiment worth a second reaction.
  { emoji: "✅", words: w("hecho|listo|perfecto|perfect|done|resuelto") },
  { emoji: "❌", words: w("error|fallo|no funciona|problema|bug") },
  { emoji: "🔥", words: w("increible|genial|brutal|excelente|awesome") },
  { emoji: "😂", words: w("jajaja|jejeje|xd") },
  { emoji: "😅", words: w("jaja|jeje") },
  { emoji: "🤔", words: w("crees|piensa|opinas|duda|pregunta|opinion") },
  { emoji: "💡", words: w("idea|propuesta|sugerencia|suggestion") },
  { emoji: "⏳", words: w("espera|esperando|tarda|demora|pronto|luego") },
  { emoji: "☕", words: w("descanso|descansar|cafe|break|pausa") },
  { emoji: "🫡", words: w("entendido|anotado|recibido") },
  { emoji: "👎", words: w("mal|incorrecto|no quiero|estaba mal") },
];

/**
 * The emoji that fits the sender's words, or null when nothing matches.
 * Null is a real answer: sending a random emoji is noise, not signal.
 */
export function semanticReaction(ctx: ReactionContext): ReactionEmoji | null {
  const text = normalizeForReaction(ctx.text ?? "");
  // Attachment-shaped rules run FIRST and are not gated on there being text: a
  // bare voice note has an empty caption and must still be recognized as one.
  for (const rule of RULES) {
    if (rule.when && rule.when(ctx)) return rule.emoji;
  }
  if (!text.trim()) return null;
  for (const rule of RULES) {
    if (rule.when) continue;
    if (rule.words?.test(text)) return rule.emoji;
    if (rule.contains && text.includes(rule.contains)) return rule.emoji;
  }
  return null;
}

/**
 * The emoji for the acceptance slot: the semantic one when the sender's words
 * carry a signal, the configured fallback (👀) otherwise. Empty means "send no
 * reaction at all" and is preserved verbatim — a muted thread stays muted.
 */
export function pickAckReaction(ctx: ReactionContext, fallback: string): string {
  if (!fallback) return "";
  return semanticReaction(ctx) ?? fallback;
}

/**
 * React to ANY message the consumer holds (not only the one being answered) —
 * this is the "poder reaccionar a cualquier mensaje" capability. Best-effort by
 * contract: the caller logs the outcome and never lets it reach the turn.
 */
export async function reactTo(
  sender: EvoSender,
  args: { number: string; key: { id: string; remoteJid: string; participant?: string }; emoji: ReactionEmoji; timeoutMs?: number },
): Promise<{ kind: "sent" } | { kind: "failed"; status?: number; error: string }> {
  try {
    return await sender.sendReaction({
      number: args.number,
      key: args.key,
      reaction: args.emoji,
      timeoutMs: args.timeoutMs ?? 2_500,
    });
  } catch (error) {
    return { kind: "failed", status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}