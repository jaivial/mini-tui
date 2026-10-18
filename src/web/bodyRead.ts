/**
 * Reading a request body, with the two rules the rest of the server is allowed
 * to assume.
 *
 * THE DEFECT THIS EXISTS TO FIX (measured against the deployed build, E40):
 *
 *   1. **No deadline.** `await request.formData()` and `await request.json()`
 *      resolve only when the client has sent everything it declared. A client
 *      that sends the headers and then stops — a tab closed mid-upload, a phone
 *      that lost signal, a peer that opened the socket to hold it — pins the
 *      handler and the socket *indefinitely*: measured >130 s with
 *      `idleTimeout: 255` in force and the connection still waiting, and the
 *      rate-limit token already spent. `Bun.serve`'s `idleTimeout` is a property
 *      of the CONNECTION, not of the handler, so it does not fire while the
 *      handler is parked on a body that is still arriving.
 *
 *   2. **A body that never arrived is indistinguishable from an empty one.**
 *      `readJson` caught every failure and returned `{}`, so a request cut in
 *      half became a *valid, empty* JSON object. Measured: `POST /api/sessions`
 *      with a truncated body answered **201**, spawned a real agent
 *      (`agent.spawn pid=…`) and left a session behind — a turn nobody asked
 *      for, and the client that had asked was already gone. The same `{}` was
 *      handed to `/sessions/:id/prompt`, `/model`, `/title`, `/hosts`,
 *      `/providers/connect`, `/router/preview` and `PATCH /settings`.
 *
 * Both are the server half of the pattern E35–E39 closed on the client: a
 * promise that resolves on the wrong event. Here the promise resolves on
 * "the client gave up", and the code cannot tell that apart from "the client
 * finished".
 *
 * THE THIRD DEFECT (measured against the deployed build, E42): **a body that
 * arrived TOO FAST was reported as one that never arrived.** The per-chunk size
 * cap raised `BodyTimeout("total")` from INSIDE the watchdog's own `try`, so
 * the `catch` right below caught it and re-labelled it `BodyTimeout("idle")`.
 * A 17 MB upload — over the 15 MB cap — answered:
 *
 *     HTTP/1.1 408 Request Timeout
 *     {"error":"the request body stopped arriving for 60s"}
 *
 * in **0,00 s**. Three lies in one answer: the status (a client that sent too
 * much is a 413, not a 408), the reason (nothing stopped arriving; the client
 * sent 17 MB in 20 ms), and the clock (it claims 60 s of silence about a body
 * that arrived whole). It hit every route with a cap, JSON included — a 2 MB
 * JSON body on a 1 MB cap answered the same way. And the truth was already in
 * the file, unreachable: `BodyOutcome` had a `"too-large"` reason and
 * `bodyRefusal` had a message for it, but nothing could ever produce it.
 *
 * So the cap now raises `BodyTooLarge` (413) from OUTSIDE the guarded loop,
 * and the watchdog's `catch` goes back to meaning what it says: the socket
 * died mid-stream.
 *
 * The rules:
 *
 *   - **A deadline is progress-based, not wall-clock.** A 15 MB upload on a
 *     500 kbit/s link legitimately takes ~4 minutes, so a total-time cap would
 *     refuse real work. What is never legitimate is *no progress for N
 *     seconds*: the client is either gone or not sending. So the watchdog
 *     resets on every chunk. The total cap exists too, and is generous.
 *   - **Absence is a value, not a `{}`.** `readJsonBody` returns a result whose
 *     shape says which happened, so a caller cannot mistake "nothing arrived"
 *     for "an empty object arrived".
 */

/** Seconds without a single byte of body before the read is given up on.
 *  Generous on purpose: this fires on a dead socket, not on a slow one. */
export const BODY_IDLE_SECONDS = 60;

/** Seconds of total budget for a body, whatever the progress. Only reached by
 *  a client trickling one byte just often enough to reset the idle timer, which
 *  is not a thing a browser does with a file. */
export const BODY_TOTAL_SECONDS = 300;

/** Milliseconds the real read is given AFTER the body ended completely. Not a
 *  deadline on the client — the body is already here — just a bound so a read
 *  that will never settle cannot hold the request open anyway. */
export const BODY_END_GRACE_MS = 5_000;

/** The cap on a JSON body, in bytes. Every JSON route here takes a small object
 *  (`{prompt}`, `{model}`, `{title}`, a settings patch); 1 MB is already three
 *  orders of magnitude past anything the app sends, and it means a truncated
 *  stream cannot grow without bound while we wait to notice. */
export const JSON_MAX_BYTES = 1024 * 1024;

/** Thrown out of a read that passed the size cap. NOT a timeout: the body
 *  arrived, fast and complete, and it was simply too much of it. Carries 413 so
 *  a route can answer the truth instead of blaming a silence that never
 *  happened (measured, E42: 17 MB over a 15 MB cap answered 408 "stopped
 *  arriving for 60s" in 0,00 s). */
export class BodyTooLarge extends Error {
  readonly status = 413;
  constructor(readonly limit: number) {
    super(`the request body is over ${limit} bytes`);
  }
}

export type BodyOutcome =
  /** The client sent everything it declared and it parsed. */
  | { ok: true; value: Record<string, unknown> }
  /** Nothing arrived, or not enough to be JSON: the request never happened. */
  | { ok: false; reason: "absent" | "truncated" | "malformed" | "too-large" };

/**
 * A request that arrived with no body at all (`content-length: 0`, measured as
 * `request.body === null` on Bun 1.4.2).
 *
 * Distinct from `BodyTimeout` on purpose: nothing stalled, nothing was cut. The
 * answer is the client's own fault — 400 "expected a JSON body" — and not the
 * server's impatience, which would be 408.
 */
export class EmptyBody extends Error {
  readonly status = 400;
  readonly absent = true;
  constructor() {
    super("the request carried no body");
  }
}

/** Thrown out of a read that gave up; carries the status the route should answer. */
export class BodyTimeout extends Error {
  readonly status = 408;
  constructor(readonly reason: "idle" | "total", idleMs = BODY_IDLE_SECONDS * 1000) {
    super(reason === "idle" ? `the request body stopped arriving for ${Math.round(idleMs / 1000)}s` : `the request body did not finish within ${BODY_TOTAL_SECONDS}s`);
  }
}

/**
 * Read `request`'s body with a progress watchdog, racing the real read.
 *
 * The watchdog watches a CLONE: `request.clone()` tees the stream, so the bytes
 * this function reads to learn about progress are the same bytes the real
 * reader gets. Measured on Bun 1.4.2: with a 300 KB body the watchdog saw
 * `[43470, 87160, 152696, 218232, 283768, 300114]` — every chunk, in order —
 * while `request.formData()` on the original still parsed the file intact.
 *
 * `read` is handed the request and does the real work (`formData()`,
 * `text()`…). `limit` is enforced while reading, not after, so a lying
 * `Content-Length` cannot get past it.
 */
export async function readBody<T>(request: Request, read: (req: Request) => Promise<T>, limit = JSON_MAX_BYTES, idleMs = BODY_IDLE_SECONDS * 1000): Promise<T> {
  // No stream at all means there IS no body, not that one stopped arriving.
  // Bun reports `content-length: 0` as `request.body === null` (measured), so
  // answering "the request body stopped arriving for 60s" to an empty POST would
  // be a lie about a request that arrived complete and simply had nothing in it.
  if (!request.body) throw new EmptyBody();

  // The watchdog watches a CLONE. `request.clone()` tees the stream, so the
  // bytes read to learn about progress are the same bytes the real reader gets:
  // measured on Bun 1.4.2, a 300 KB body showed every chunk in order
  // ([43470, 87160, 152696, 218232, 283768, 300114]) while `formData()` on the
  // original still parsed the file intact. Reading the ORIGINAL instead locks
  // it (`ERR_BODY_ALREADY_USED`), which is how this first went wrong.
  const watch = request.clone().body;
  if (!watch) throw new EmptyBody();

  // One slot, three jobs: re-armed on every chunk, and it is what ENDS the wait.
  //
  // The deadline has to REJECT THE RACE ITSELF. An earlier version set a flag
  // and let the reader loop notice — but that loop is parked in `read()`
  // waiting for the very bytes that will never come, so nothing re-checks the
  // flag and the request hangs exactly as before. The timer is the only party
  // that can wake up on its own, so it is the one that settles the promise.
  let settleIdle!: (error: Error) => void;
  const idle = new Promise<never>((_, reject) => { settleIdle = reject; });
  let armed: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (armed) clearTimeout(armed);
    // ARMED BEFORE THE FIRST READ: a client that sends the headers and not one
    // byte is the E40 hang, and a timer created only after the first chunk
    // arrives leaves precisely that case unguarded.
    armed = setTimeout(() => settleIdle(new BodyTimeout("idle", idleMs)), idleMs);
    (armed as unknown as { unref?: () => void }).unref?.();
  };
  arm();

  const reader = watch.getReader();
  let seen = 0;
  // The cap settles the race ITSELF, and it does NOT throw (E42). Thrown from
  // inside the guarded loop, `BodyTimeout` was caught by the `catch` right
  // below and re-labelled `idle`: a 17 MB body on a 15 MB cap answered 408
  // "the request body stopped arriving for 60s" after 0,00 s — three lies in
  // one answer. The `catch` is for ONE thing, the socket dying mid-stream; how
  // much arrived is not that. Settling here also means the answer does not wait
  // for the client to finish sending what we already know we will refuse.
  let settleOversize!: (error: Error) => void;
  const oversize = new Promise<never>((_, reject) => { settleOversize = reject; });
  const watchdog = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return; // the body arrived COMPLETE: `real` settles on its own
        seen += value?.byteLength ?? 0;
        if (seen > limit) return settleOversize(new BodyTooLarge(limit));
        arm(); // progress: the deadline moves, because only SILENCE is a hang
      }
    } catch {
      // A read failure mid-stream is the client's socket going away — the same
      // thing the idle deadline names, so the guard answers for it.
      settleIdle(new BodyTimeout("idle", idleMs));
    }
  })();

  let settleTotal!: (error: Error) => void;
  const ceiling = new Promise<never>((_, reject) => { settleTotal = reject; });
  const total = setTimeout(() => settleTotal(new BodyTimeout("total", idleMs)), BODY_TOTAL_SECONDS * 1000);
  (total as unknown as { unref?: () => void }).unref?.();

  try {
    return await Promise.race([read(request), idle, ceiling, oversize]);
  } finally {
    if (armed) clearTimeout(armed);
    clearTimeout(total);
    void watchdog;
  }
}

/**
 * The JSON body, or an honest account of why there isn't one.
 *
 * `readJson`'s old contract — return `{}` for anything that is not JSON — is
 * what let a truncated request become a real agent spawn. The absence of a
 * body is a fact about the request, and it is now returned as one.
 */
export async function readJsonBody(request: Request, idleMs = BODY_IDLE_SECONDS * 1000): Promise<BodyOutcome> {
  let text: string;
  try {
    text = await readBody(request, (req) => req.text(), JSON_MAX_BYTES, idleMs);
  } catch (error) {
    // A body of 0 bytes is ABSENCE, a fact about the request — not a socket
    // that went away mid-body. A runtime that reports a bodiless POST as a
    // non-null stream fails the read instead of throwing EmptyBody, so a
    // declared length of 0 is the same fact seen from the other side, and it is
    // a header: true before anything has been read.
    if (error instanceof EmptyBody || request.headers.get("content-length") === "0") return { ok: false, reason: "absent" };
    // The body did not stop arriving — too much of it arrived. Before this,
    // `BodyTooLarge` did not exist and the cap came back as a `BodyTimeout`,
    // which every route answered 408 (E42).
    if (error instanceof BodyTooLarge) return { ok: false, reason: "too-large" };
    if (error instanceof BodyTimeout) throw error;
    return { ok: false, reason: "truncated" };
  }
  if (!text.trim()) return { ok: false, reason: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "malformed" };
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** The refusal body for a read that gave up. Shared so every route answers the
 *  same way: a client that stops sending is told so, and is not treated as if
 *  it had sent an empty object. */
export function bodyRefusal(outcome: BodyOutcome): string | null {
  if (outcome.ok) return null;
  if (outcome.reason === "absent") return "expected a JSON body";
  // Reachable only since E42. Before it, nothing could produce "too-large", so
  // this line never ran and the cap was reported as a stall by another path.
  if (outcome.reason === "too-large") return `the request body is over ${JSON_MAX_BYTES} bytes`;
  return "the request body is not valid JSON";
}
