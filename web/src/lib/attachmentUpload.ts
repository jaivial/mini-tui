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

/** Milliseconds of budget a SMALL upload gets. Kept at the floor the server
 *  uses for one (`BODY_TOTAL_FLOOR_SECONDS`), so a small file behaves exactly as
 *  it did before E43. */
export const UPLOAD_DEADLINE_FLOOR_MS = 5 * 60_000;

/** What the backstop adds to the transfer budget so it never pre-empts the
 *  server's own answer. */
export const UPLOAD_BACKSTOP_SLACK_MS = 60_000;

/** The rate an upload may still be running at and count as WORKING (E43).
 *  12.5 KiB/s is about 100 kbit/s -- a slow mobile uplink that is slow and
 *  finishing, not one that is stuck. Matches the server's own floor. */
export const UPLOAD_MIN_BYTES_PER_SECOND = 12_800;

/**
 * How long an upload of `size` bytes may take before it is abandoned.
 *
 * THE DEFECT THIS FIXES (measured against the deployed build, E43, CDP with the
 * upload throttled to 30 kB/s): the deadline was a FLAT five minutes, so it
 * decided the answer without asking how much was still owed. A 14,8 MB file --
 * inside the 15 MB `ATTACH_MAX`, picked from the real file input -- was aborted
 * by this deadline at **t+304 s**, and because an abort is read as "the user
 * changed their mind" the failure was painted as NOTHING: the chip vanished and
 * no toast ever appeared. The network log had one entry, `net::ERR_ABORTED
 * canceled:true`, at the same instant. The user was told nothing about a file
 * they had watched crawl for five minutes.
 *
 * So the budget is the time this file needs at a working rate, and the floor
 * keeps every small upload exactly where it was. A 15 MB file gets 1 289 s
 * instead of 300 s: enough that the SERVER's honest answer wins the race, which
 * is the point -- the backstop exists for a request nobody is watching, not to
 * pre-empt a transfer that is still moving.
 */
export function uploadDeadlineMs(size: number): number {
  const scaled = Math.ceil((size / UPLOAD_MIN_BYTES_PER_SECOND) * 1000);
  // The slack is what keeps the ORDER right: the client backstop has to sit
  // ABOVE the server's own ceiling, so when a transfer really is too slow the
  // answer the user sees is the server's ("the request body did not finish
  // within N s"), not a client-side abort with no explanation. Measured without
  // it, a 15 MB file got 1228,8 s here against the server's 1230 s -- the client
  // would have won a race it should have lost, by 1,2 s.
  return Math.max(UPLOAD_DEADLINE_FLOOR_MS, scaled + UPLOAD_BACKSTOP_SLACK_MS);
}

/** Kept for the callers that only want "the small-file budget". */
export const UPLOAD_DEADLINE_MS = UPLOAD_DEADLINE_FLOOR_MS;

export function createUploadState(): UploadState {
  return { draft: 0, current: new Map() };
}

/**
 * Begin uploading `file`, returning its token.
 *
 * The caller must check `isCurrent` before acting on the answer: this hands out the claim,
 * it does not keep it.
 */
export function beginUpload(state: UploadState, file: File, key?: string, deadlineMs = uploadDeadlineMs(file.size)): UploadToken {
  const token: UploadToken = {
    key: key ?? `${file.name}:${file.size}:${Math.random().toString(36).slice(2, 9)}`,
    draft: state.draft,
    controller: new AbortController(),
    file,
  };
  // The deadline aborts with a REASON. An abort the user asked for is silent, but
  // this one is the app giving up on a file that was still moving, and E43
  // measured exactly what silence costs: the chip vanished at t+304 s with no
  // toast, because `isCancel` cannot tell the two apart on the error alone.
  const timer = setTimeout(() => token.controller.abort(new UploadDeadline(deadlineMs)), deadlineMs);
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
 * The backstop gave up on an upload that was still in flight.
 *
 * Carries the budget it actually gave, so the message can name it instead of
 * the caller guessing (E43).
 */
export class UploadDeadline extends Error {
  readonly name = "UploadDeadline";
  constructor(readonly ms: number) {
    super(`the upload did not finish within ${Math.round(ms / 1000)}s`);
  }
}

/**
 * Whether a failed upload is worth reporting.
 *
 * An abort is the user pressing Cancel, switching conversation or closing the pane. Painting
 * that as "could not attach the file" would be wrong in the same way E38's was: it reports
 * the app's own decision as the server's failure.
 *
 * But the app also aborts on its OWN deadline, and that is a failure worth
 * saying out loud -- it is not the server refusing, and it is not the user
 * changing their mind, so it belongs in neither bucket. `UploadDeadline` names
 * that case, so it is reported instead of vanishing (measured, E43).
 */
export function isCancel(error: unknown): boolean {
  if (error instanceof UploadDeadline) return false;
  return error instanceof Error && error.name === "AbortError";
}
