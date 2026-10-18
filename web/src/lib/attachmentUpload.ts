/**
 * Ownership and cancellation rules for the prompt bar's file uploads.
 *
 * They exist because of a defect measured in the browser, and it is the one web request
 * that WRITES. `uploadAttachment` posted the file with a bare `fetch("/api/attachments",
 * { method: "POST", body })` -- no `signal`, no timeout -- and the composer's chip row had
 * no way out. Measured against the deployed build, holding the POST open with CDP:
 *
 * - **The user could not escape.** The in-flight chip rendered a spinner and a filename and
 *   **zero** buttons, so a stalled upload could not be cancelled; `canSend` is false while
 *   `uploading.length`, so Send stayed disabled at t+2.5 s, t+12 s, t+22 s and t+42 s with
 *   nothing to press. A second file could be added and hang on top of the first.
 * - **The answer outlived the message it was picked for.** The chip's `finally` did
 *   `attachments = [...attachments, ref]` with no idea whose draft that was. Starting an
 *   upload against the open session `xfh-probe`, switching to a new chat (which clears
 *   `pane.attachments`) and only then letting the POST answer put the file into the fresh
 *   draft: it went out with the next, unrelated message --
 *   `POST /api/sessions {"prompt":"hola, esto es otra cosa", ... "attachments":[{"name":"secreto-e39.png"}]}`.
 * - **The server kept holding it.** A stalled body (headers declaring 15 MB, eight bytes
 *   sent) left the connection open past 100 s with no answer and no close, so nothing on
 *   either side ever declared the attempt finished.
 *
 * Three rules, the same shape as `channelsLoad` (E38) but heavier here, because this
 * request puts a file on disk:
 *
 * - every upload takes a real **AbortController**, so the chip can cancel it, leaving the
 *   pane cancels it, and unmounting cancels it;
 * - every upload takes a **deadline**, so a composer nobody is watching still frees itself;
 * - every upload belongs to the **draft it was picked in**: an answer that lands after the
 *   pane moved to another conversation may not attach itself to it -- and must not be able
 *   to later either, which is why this asks about the token, not about the component.
 *
 * An abort is the user changing their mind, not an upload failing, so `isCancel` keeps it
 * from being painted as an error.
 *
 * No Svelte in here, so a test can hold the rules down.
 */

/** What the chip row renders while a file is on its way. */
export interface PendingUpload {
  key: string;
  name: string;
  size: number;
}

/** One upload's claim: which draft it belongs to, and how to cancel it. */
export interface UploadToken {
  /** Stable per attempt, so the chip and the cancel button agree on which one. */
  readonly key: string;
  /** The draft generation this upload was started in. A later one means "not yours". */
  readonly draft: number;
  readonly controller: AbortController;
  readonly file: File;
}

/** A pane's upload bookkeeping. Plain and mutable on purpose: nothing here renders. */
export interface UploadState {
  /** Bumped whenever the pane starts showing a different conversation. */
  draft: number;
  /** In-flight uploads, by key. An upload is removed only by its own settlement. */
  readonly current: Map<string, UploadToken>;
}

/**
 * How long an upload may take before it is abandoned.
 *
 * The largest legal file is 15 MB (`ATTACH_MAX`), and on a phone at 500 kbit/s that is
 * four minutes of honest transfer -- so this is deliberately far above any legitimate
 * upload. It is here for the case where nobody is left to press Cancel: a request that
 * never settles must not keep `canSend` false for the rest of the session. The deadline is
 * the backstop; the chip's cancel button is the way out.
 */
export const UPLOAD_DEADLINE_MS = 5 * 60_000;

export function createUploadState(): UploadState {
  return { draft: 0, current: new Map() };
}

/**
 * Begin uploading `file`, returning its token.
 *
 * The caller must check `isCurrent` before acting on the answer: this hands out the claim,
 * it does not keep it.
 */
export function beginUpload(state: UploadState, file: File, key?: string, deadlineMs = UPLOAD_DEADLINE_MS): UploadToken {
  const token: UploadToken = {
    key: key ?? `${file.name}:${file.size}:${Math.random().toString(36).slice(2, 9)}`,
    draft: state.draft,
    controller: new AbortController(),
    file,
  };
  const timer = setTimeout(() => token.controller.abort(), deadlineMs);
  // The timer must not hold the process open on its own account; the request is what keeps
  // the work alive, and it is aborted by the same deadline.
  (timer as unknown as { unref?: () => void }).unref?.();
  state.current.set(token.key, token);
  token.controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return token;
}

/**
 * Whether `token` may still attach its file to this pane.
 *
 * False once the pane has moved to another conversation, once the upload was cancelled, or
 * once it was superseded under its own key. Answering about the token rather than about
 * whatever the component currently holds is what stops a late answer from arriving later
 * and finding a slot open.
 */
export function isCurrent(state: UploadState, token: UploadToken): boolean {
  return state.current.get(token.key) === token && token.draft === state.draft && !token.controller.signal.aborted;
}

/** Mark `token` finished. Only that upload may clear its own slot. */
export function settleUpload(state: UploadState, token: UploadToken): void {
  if (state.current.get(token.key) === token) state.current.delete(token.key);
}

/**
 * Cancel one upload -- what the chip's button does. Aborting really settles the request,
 * which is the whole point: a fetch the caller cannot cancel is a fetch the user cannot
 * get out of.
 */
export function cancelUpload(state: UploadState, key: string): boolean {
  const token = state.current.get(key);
  if (!token) return false;
  state.current.delete(key);
  token.controller.abort();
  return true;
}

/**
 * The pane is showing a different conversation now, so nothing still in flight belongs to
 * what is on screen. Every pending upload is aborted and the draft moves on.
 *
 * Returns how many were cancelled, so the caller can say so instead of leaving the user to
 * wonder where the file went.
 */
export function abandonDraft(state: UploadState): number {
  const pending = [...state.current.values()];
  state.draft += 1;
  for (const token of pending) state.current.delete(token.key);
  for (const token of pending) token.controller.abort();
  return pending.length;
}

/** Abort everything without moving the draft on: the pane is going away. */
export function cancelAllUploads(state: UploadState): number {
  const pending = [...state.current.values()];
  for (const token of pending) {
    state.current.delete(token.key);
    token.controller.abort();
  }
  return pending.length;
}

/**
 * The chips to paint, as a NEW array every call.
 *
 * The E36 lesson: mutating and returning the same array is what Svelte cannot see, and the
 * symptom is a spinner that keeps spinning after the file landed.
 */
export function pendingUploads(state: UploadState): PendingUpload[] {
  return [...state.current.values()].map((t) => ({ key: t.key, name: t.file.name, size: t.file.size }));
}

/**
 * Whether a failed upload is worth reporting.
 *
 * An abort is the user pressing Cancel, switching conversation or closing the pane. Painting
 * that as "could not attach the file" would be wrong in the same way E38's was: it reports
 * the app's own decision as the server's failure.
 */
export function isCancel(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
