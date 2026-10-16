/**
 * What a failed turn tells the user — and, just as important, what it must never tell them.
 *
 * A turn's `error` field is not a verdict, it is whatever the agent process left at the bottom of
 * its combined stdout+stderr log. That log carries BOTH real failures (`the run ended with
 * TimeExceeded`) and mere diagnostics (`[turn] resumed session held 1 unfinished copy of this
 * task; collapsed into one`). The collapse notice is the E4 fix WORKING — but because it was the
 * last line written, it became the whole error text and reached the chat in place of the real
 * cause, which had been `TimeExceeded` on the previous attempt (seq=59, 2026-10-16).
 *
 * So the diagnostics are filtered out here, and the surviving cause is translated into something a
 * person can act on. The user is not an operator reading a Rust agent's log tail: they asked for
 * work in a chat and got nothing back, and the only honest thing to say is which of the few things
 * actually went wrong.
 */

/** Lines the agent writes for the operator, never as the cause of a failure.
 *
 * `[turn]` is the current prefix (agent-rs emits it for the resume collapse); the `WARNING:`
 * spelling is kept so a log written by an older binary is still recognised while it rolls out. The
 * line is matched on its opening words only — `]` and `:` are non-word characters, so a trailing
 * `\b` would never match here. */
const TURN_DIAGNOSTIC = /^\s*(?:\[turn\]\s|WARNING:\s*the resumed session already held\b)/;

/** One diagnostic line, or a continuation of one. The agent writes these single-line today, but a
 * diagnostic that ever grows a second line must not leak that fragment back into the error. */
function isDiagnosticLine(line: string): boolean {
  return TURN_DIAGNOSTIC.test(line) || /^\s*(?:cop(?:y|ies) of this task\b|collapsed into one\b)/.test(line);
}

/** Drop every diagnostic line from a raw run-log tail.
 *
 * A tail that was nothing but diagnostics comes back empty, which is the honest result: there is no
 * error text to report, so the caller must fall back to the run's exit status instead of quoting
 * the noise. */
export function stripTurnDiagnostics(text: string): string {
  const kept = text
    .split("\n")
    .filter((line) => !isDiagnosticLine(line))
    .join("\n")
    .trim();
  return kept;
}

/** The cause of a failed turn, as `error` should carry it: the log's tail with the operator
 * diagnostics removed. Empty when the tail held nothing but diagnostics. */
export function turnFailureCause(error: string | undefined | null): string {
  return stripTurnDiagnostics(error ?? "");
}

/** Every exit status the agent can end a turn with that is not a plain success. Ordered by how
 * specific the wording can be: the first match wins. */
const CAUSES: { match: RegExp; es: string; en: string }[] = [
  { match: /TimeExceeded/i, es: "el turno superó el tiempo límite", en: "the turn ran out of time" },
  { match: /LimitsExceeded/i, es: "el turno agotó sus límites de pasos o coste", en: "the turn used up its step or cost budget" },
  { match: /ProviderQuotaError|\b429\b|quota|rate.?limit/i, es: "el proveedor del modelo no tiene cuota disponible", en: "the model provider is out of quota" },
  { match: /ProviderAbortError|ProviderError|\b(401|403|404|500|502|503|504)\b|provider|api.?key|unauthorized|connection refused/i, es: "falló el proveedor del modelo", en: "the model provider failed" },
  { match: /ContextOverflow|context.?length|too many tokens/i, es: "la conversación creció demasiado para el modelo", en: "the conversation outgrew the model's context" },
  { match: /Cancelled/i, es: "el turno se canceló", en: "the turn was cancelled" },
  { match: /KeyboardInterrupt/i, es: "el turno se interrumpió", en: "the turn was interrupted" },
  { match: /compaction summary failed/i, es: "no se pudo resumir la conversación", en: "the conversation could not be compacted" },
];

/** Turn-end statuses that mean the run ended WITHOUT answering, whatever the log says. They are
 * the authoritative cause: a resumed run that collapsed copies and then hit its wall-clock limit
 * writes both, and the status is the one that ended it. */
const ENDED_WITHOUT_ANSWER: { match: RegExp; es: string; en: string }[] = [
  { match: /^TimeExceeded$/i, es: "el turno superó el tiempo límite", en: "the turn ran out of time" },
  { match: /^LimitsExceeded$/i, es: "el turno agotó sus límites de pasos o coste", en: "the turn used up its step or cost budget" },
];

/** Spanish, as it is actually written. `¿`/`¡` and `ñ` cannot appear in an English sentence by
 * accident, so one is already a decision; the accented vowels and the closed-class function words
 * only tilt the balance. Every other reply in a bound thread already follows the sender's language
 * (see `turnPrompt`), so this note has to as well — a Spanish failure note under an English question
 * reads like a different bot answered. */
const ES_STRONG = /[¿¡ñ]/;
const ES_WEAK = /[áéíóúü]|\b(?:el|la|los|las|un|una|de|del|que|para|con|por|como|pero|más|está|están|hay|este|esta|esto|mis|tus|su)\b/gi;

/** Which language to answer a failure in. Ties go to Spanish: the bound threads this consumer
 * serves are Spanish, and a wrong guess must not make the note unreadable for its usual reader. */
export function replyLanguage(text: string): "es" | "en" {
  if (ES_STRONG.test(text)) return "es";
  return (text.match(ES_WEAK)?.length ?? 0) >= 2 ? "es" : "en";
}

/** Why a turn failed, in one sentence a person can act on — or "" when nothing recognizable is
 * left, so the caller can say so honestly instead of pasting a log line. */
export function describeTurnFailure(error: string | undefined | null, exitStatus?: string | undefined, lang: "es" | "en" = "es"): string {
  const status = (exitStatus ?? "").trim();
  const ended = ENDED_WITHOUT_ANSWER.find((c) => c.match.test(status));
  if (ended) return ended[lang];
  const cause = turnFailureCause(error);
  for (const entry of CAUSES) {
    if (entry.match.test(status) || (cause && entry.match.test(cause))) return entry[lang];
  }
  return "";
}

/** How the failure note opens, per language. Anchoring on the note's own wording is what makes it
 * recognizable as the honest-failure note and never as something the agent actually said. */
const NOTE_OPENERS = {
  es: "(no he podido completar esta tarea:",
  en: "(I could not complete this task:",
} as const;

/** Whether a reply is the honest failure note rather than a real answer.
 *
 * This is a load-bearing signal, not cosmetics: the media/evidence logic refuses to treat a failure
 * note as proof that anything was delivered (two turns can fail with the byte-identical note, so a
 * note is never text-evidence — only its quoted stanza id may identify it). */
export function isTurnFailureNote(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith(NOTE_OPENERS.es) || trimmed.startsWith(NOTE_OPENERS.en);
}

/** The note the user reads when a turn never produced an answer.
 *
 * Only the mapped cause is ever included: a raw log tail is full of paths, provider jargon and
 * HTTP codes that mean nothing in a chat and can name the internal failure instead of the real one. */
export function turnFailureNote(error: string | undefined | null, exitStatus?: string | undefined, lang: "es" | "en" = "es"): string {
  const reason = describeTurnFailure(error, exitStatus, lang);
  const opener = NOTE_OPENERS[lang];
  return reason ? `${opener} ${reason})` : `${opener.slice(0, -1)})`;
}
