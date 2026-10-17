/**
 * The audio prompt bar, as a state machine.
 *
 * Measured in Chrome 145 against the deployed build (`index-CRXhCKGk.js`), recording for
 * real through `MediaRecorder` with a fake capture device, and failing the upload for real
 * with a CDP `Fetch` interception returning 503. Four defects, one cause: the component
 * decided what to show from a few ad-hoc booleans about the LIVE microphone, and had no
 * notion of "a take exists" as a state with its own rules.
 *
 *   1. THE `recorded` STATE HAD NO WAY TO SEND THE TAKE. The submit button was gated on
 *      `live` (recording or requesting), but the state machine reaches `recorded` on its
 *      own: `maxDurationMs` (5 min) calls `stop()` from `readFrame`, and a failed upload
 *      returns to `recorded` with the take still in hand. Measured: a real 5-minute take
 *      hit the cap at 300.3 s and the row offered exactly two buttons — "Descartar la nota
 *      de voz" and a mic labelled "Nota de voz lista". Five minutes of the user's voice,
 *      with no way to send it and no warning that it was about to be lost. The controller
 *      already publishes `canSubmit` for exactly this (`recording || recorded`); the
 *      component never read it.
 *   2. A FAILED UPLOAD DISCARDED THE TAKE. `attachRecording` caught the error itself, so
 *      the controller's `submitRecording` saw a *resolved* promise and reset to `idle` with
 *      `recording: undefined`. Measured: POST cut with a 503 → state `idle`, 0 attachments,
 *      0 toasts on screen to explain it, the take gone. The recorder even has a state for
 *      this (`recorded` + `error`, with the take kept) — nothing could reach it.
 *   3. THE COMPOSER'S MIC TUNED OFF DISCARDED THE TAKE IN SILENCE. The outer mic is a
 *      plain `recordingOpen = !recordingOpen` toggle, and unmounting the recorder runs
 *      `destroy()` → `cancelInternal(false)`. Measured: 1.5 s recorded, click the outer
 *      mic → panel gone, take gone, 0 toasts. The mic's own `aria-expanded` said the panel
 *      was open, so it read as "close", not "throw away what you just said".
 *   4. FOCUS WAS LOST THE MOMENT RECORDING STARTED, AND ESCAPE DID NOTHING. The trigger is
 *      `disabled` while live, and disabling the focused element drops focus to `body`
 *      (measured: `activeElement === BODY` right after Enter started the recording), so the
 *      next Tab restarted at the top of the document and the user could not reach "Enviar"
 *      without tabbing through the whole app. And Escape — the key every other overlay in
 *      this app binds — left the state at `recording`: the microphone stayed open.
 *
 * The rules live here for the reason `renameField.ts` gives: this is the logic the bar's
 * behaviour IS made of, it has to be testable on its own, and the component should only
 * call it and paint what it says.
 */

export type RecorderState = "idle" | "requesting" | "recording" | "recorded" | "submitting" | "error";

/** Control UI's own wording, so a screen reader hears the sentence its component would. */
const STATUS: Record<RecorderState, string> = {
  idle: "",
  requesting: "Esperando permiso del micrófono",
  recording: "Grabando",
  recorded: "Nota de voz lista",
  submitting: "Enviando la nota de voz",
  error: "",
};

export interface RecorderBarInput {
  state: RecorderState;
  /** The upload's own reason, when it failed and the take was kept. */
  error?: Error | null;
}

export interface RecorderBarView {
  /** What the status line says, visible and announced. */
  status: string;
  /** The status line is the error's own sentence, in the error tone. */
  statusIsError: boolean;
  /** The mic trigger exists (it is hidden once a take is in hand). */
  showTrigger: boolean;
  /** The trigger is unclickable while the mic is busy. */
  triggerDisabled: boolean;
  /** What the trigger announces: its own action, or the state it would start from. */
  triggerLabel: string;
  /** "Enviar la nota de voz" — shown whenever a take exists, live or stopped. */
  showSubmit: boolean;
  submitDisabled: boolean;
  /** "Descartar" — the only way out of a take that is not sending it. */
  showCancel: boolean;
  cancelLabel: string;
  /**
   * The cancel glyph. The retry arrow only belongs where there is NO take to lose (the
   * mic was never granted); with a kept take the verb is "descartar" and the icon has to
   * say so too — a screenshot caught them disagreeing.
   */
  cancelIsRetry: boolean;
  /** The visualizer animates only while the microphone is actually open. */
  meterActive: boolean;
  /** The duration readout is worth showing only once there is a length to show. */
  showDuration: boolean;
  /** Escape / the outer toggle has something to throw away. */
  canDiscard: boolean;
}

const RECORDER_LABEL = "Grabar nota de voz";

/** The take exists in memory and has not been sent yet. */
export function recorderHasTake(state: RecorderState): boolean {
  return state === "recorded";
}

/** Escape (or the outer toggle) may throw the take away from any of these. */
export function recorderCanDiscard(state: RecorderState): boolean {
  return state === "requesting" || state === "recording" || state === "recorded" || state === "error";
}

/**
 * What to paint, given the machine's state.
 *
 * The rule that was missing: `recorded` is a state with a take IN it, so it gets the same
 * send affordance `recording` has. Losing the take was never the intent of the cap or of a
 * failed upload — both keep the blob, and the blob is the user's voice.
 */
export function recorderBarView(input: RecorderBarInput): RecorderBarView {
  const { state, error } = input;
  const errored = state === "error" || (state === "recorded" && Boolean(error));
  // "Volver a grabar" is only true when nothing was recorded: a failed UPLOAD kept a take,
  // and what you can do with it is send it or throw it away.
  const retryable = state === "error" && !recorderHasTake(state);
  const live = state === "recording" || state === "requesting";
  const sending = state === "submitting";
  // The controller's own `canSubmit` is `recording || recorded`; `submitting` joins it so
  // the row does not collapse under the very upload the user just started, and so a kept
  // take after a failed upload stays one click from the retry.
  const submittable = live || state === "recorded" || sending;

  const status = errored ? error?.message || "No se pudo grabar" : STATUS[state];

  // The trigger's own label says what the BUTTON does, never the error sentence: in the
  // `error` state the mic is the retry, and labelling it with a 90-character message made
  // the control announce itself as a paragraph (measured live on 4317). The error lives on
  // the status line, which is visible and announced.

  return {
    status,
    statusIsError: errored,
    // With a take in hand the mic is not a verb the user wants; "Descartar" re-arms it.
    showTrigger: !recorderHasTake(state),
    triggerDisabled: sending || live,
    triggerLabel: RECORDER_LABEL,
    showSubmit: submittable,
    submitDisabled: sending,
    showCancel: live || recorderHasTake(state),
    cancelLabel: retryable ? "Descartar y volver a grabar" : "Descartar la nota de voz",
    cancelIsRetry: retryable,
    meterActive: live,
    showDuration: live || state === "recorded",
    canDiscard: recorderCanDiscard(state),
  };
}
