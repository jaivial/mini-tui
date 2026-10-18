/**
 * The prompt bar's upload ownership.
 *
 * The defect these hold down was measured against the deployed build with CDP, holding the
 * `POST /api/attachments` response open. It is the one web request that WRITES, and it had
 * no `signal`, no timeout and no way out:
 *
 * - the in-flight chip rendered a spinner and a filename and **zero** buttons, and
 *   `canSend` is false while `uploading.length`, so Send stayed disabled at t+2.5, t+12,
 *   t+22 and t+42 s with nothing to press;
 * - the answer landed after the user had moved to another conversation and attached the file
 *   to the NEXT message -- measured body:
 *   `POST /api/sessions {"prompt":"hola, esto es otra cosa", ... "attachments":[{"name":"secreto-e39.png"}]}`;
 * - a stalled body (headers declaring 15 MB, eight bytes sent) left the server holding the
 *   connection open past 100 s with no answer and no close.
 *
 * The last-response-wins rule that caused the second one is reproduced at the bottom as
 * `mainLogic`, so the control A/B fails against what origin/main actually does.
 */
import { describe, expect, test } from "bun:test";

import {
  abandonDraft,
  beginUpload,
  cancelAllUploads,
  cancelUpload,
  createUploadState,
  isCancel,
  isCurrent,
  pendingUploads,
  settleUpload,
  UPLOAD_DEADLINE_FLOOR_MS,
  UPLOAD_BACKSTOP_SLACK_MS,
  UPLOAD_MIN_BYTES_PER_SECOND,
  UploadDeadline,
  uploadDeadlineMs,
} from "../web/src/lib/attachmentUpload";
import { bodyTotalSeconds, BODY_MIN_BYTES_PER_SECOND as SERVER_MIN_RATE } from "../src/web/bodyRead";
import { ATTACH_MAX } from "../web/src/lib/attachments";
import { ATTACH_MAX_BYTES } from "../src/web/attachments";

/** Whether a token may still attach its file to this draft. */
const attaches = (state: ReturnType<typeof createUploadState>, token: ReturnType<typeof beginUpload>) => isCurrent(state, token);

/** A stand-in for the file the picker produces; `attachments.ts` only reads name and size. */
function fakeFile(name: string, size = 2000): File {
  return { name, size } as File;
}

describe("upload ownership", () => {
  test("an upload in flight is the one the chip is waiting for", () => {
    const state = createUploadState();
    const token = beginUpload(state, fakeFile("a.png"));
    expect(attaches(state, token)).toBe(true);
    expect(pendingUploads(state)).toEqual([{ key: token.key, name: "a.png", size: 2000 }]);
  });

  // THE BUG, measured: the file was picked for one conversation; the user moved to another
  // (which clears pane.attachments); the POST then answered and the file attached itself to
  // the new draft, riding out with the next unrelated message.
  test("an answer that lands after the pane moved on may not attach to the new draft", () => {
    const state = createUploadState();
    const token = beginUpload(state, fakeFile("secreto-e39.png"));

    // The user switches conversation.
    expect(abandonDraft(state)).toBe(1);

    // The POST finally answers. It belongs to the draft that no longer exists.
    expect(attaches(state, token)).toBe(false);
  });

  test("moving on really aborts the requests it drops", () => {
    const state = createUploadState();
    const a = beginUpload(state, fakeFile("a.png"));
    const b = beginUpload(state, fakeFile("b.png"));
    expect(a.controller.signal.aborted).toBe(false);
    expect(b.controller.signal.aborted).toBe(false);
    abandonDraft(state);
    expect(a.controller.signal.aborted).toBe(true);
    expect(b.controller.signal.aborted).toBe(true);
  });

  // The one way out the chip did not have: measured with the POST held, the chip rendered
  // zero buttons and Send stayed disabled. A cancel that only hid the spinner would leave
  // the request running, so this asserts on the signal.
  test("the chip's cancel aborts the request for real", () => {
    const state = createUploadState();
    const token = beginUpload(state, fakeFile("lenta.png"));
    expect(cancelUpload(state, token.key)).toBe(true);
    expect(token.controller.signal.aborted).toBe(true);
    expect(attaches(state, token)).toBe(false);
    expect(pendingUploads(state)).toEqual([]);
  });

  test("cancelling an upload twice is not an error, and does not touch another one", () => {
    const state = createUploadState();
    const a = beginUpload(state, fakeFile("a.png"), "k-a");
    const b = beginUpload(state, fakeFile("b.png"), "k-b");
    expect(cancelUpload(state, "k-a")).toBe(true);
    expect(cancelUpload(state, "k-a")).toBe(false);
    expect(attaches(state, b)).toBe(true);
    expect(a.controller.signal.aborted).toBe(true);
  });

  // Measured: with two files held open, the second stacked on the first and NEITHER could be
  // removed. Cancelling one must leave the other alone.
  test("two uploads can be in flight and are cancelled independently", () => {
    const state = createUploadState();
    const a = beginUpload(state, fakeFile("a.png"), "k-a");
    const b = beginUpload(state, fakeFile("b.png"), "k-b");
    expect(pendingUploads(state).map((u) => u.name)).toEqual(["a.png", "b.png"]);
    cancelUpload(state, "k-a");
    expect(pendingUploads(state).map((u) => u.name)).toEqual(["b.png"]);
    expect(attaches(state, b)).toBe(true);
  });

  // The stale token must never become attachable again, not even after the pane has moved on
  // and settled other work. The assertion is about the TOKEN, not about the map being empty:
  // an upload that answers late finds a map it could have been allowed into.
  test("a dropped upload is never attachable again, whatever happens afterwards", () => {
    const state = createUploadState();
    const dropped = beginUpload(state, fakeFile("secreto-e39.png"), "k-old");

    abandonDraft(state); // the user moves to another conversation
    const fresh = beginUpload(state, fakeFile("b.png"), "k-new"); // and starts a new upload
    settleUpload(state, fresh);
    expect(state.current.size).toBe(0); // the new draft is idle again

    // The old POST answers into that idle state. It still may not attach.
    expect(attaches(state, dropped)).toBe(false);
  });

  test("only its own upload may clear its slot", () => {
    const state = createUploadState();
    const a = beginUpload(state, fakeFile("a.png"), "k-a");
    const b = beginUpload(state, fakeFile("b.png"), "k-b");
    // `a` settles late. It must not evict `b`, still the answer being awaited.
    settleUpload(state, a);
    expect(pendingUploads(state).map((u) => u.name)).toEqual(["b.png"]);
    expect(attaches(state, b)).toBe(true);
  });

  // The pane going away takes its uploads with it: measured, a page reload cleared the UI
  // while the POST stayed in flight and the file had already been written to disk.
  test("leaving the pane cancels everything without moving the draft on", () => {
    const state = createUploadState();
    const a = beginUpload(state, fakeFile("a.png"), "k-a");
    const b = beginUpload(state, fakeFile("b.png"), "k-b");
    const draft = state.draft;
    expect(cancelAllUploads(state)).toBe(2);
    expect(a.controller.signal.aborted).toBe(true);
    expect(b.controller.signal.aborted).toBe(true);
    expect(state.current.size).toBe(0);
    expect(state.draft).toBe(draft);
  });

  // Measured: the server held a stalled body open past 100 s with no answer and no close,
  // so `canSend` could stay false for the rest of the session with nobody left to press Cancel.
  test("an upload nobody is waiting for still gives up on its own", async () => {
    const state = createUploadState();
    const token = beginUpload(state, fakeFile("colgada.png"), "k", 20);
    expect(attaches(state, token)).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(token.controller.signal.aborted).toBe(true);
    expect(attaches(state, token)).toBe(false);
  });

  test("the deadline is far above any legitimate upload", () => {
    // E43: this held only for a SMALL file, because the budget was a flat five
    // minutes. The claim was true of the floor and false of the thing it was
    // written about -- the largest legal upload, which is what the backstop is
    // for. It is now asked of the 15 MB case as well.
    expect(UPLOAD_DEADLINE_FLOOR_MS).toBeGreaterThan(4 * 60_000);
    expect(uploadDeadlineMs(15 * 1024 * 1024)).toBeGreaterThan(4 * 60_000);
    // And the two sides agree on what "working" means, or the same bug ships twice.
    expect(UPLOAD_MIN_BYTES_PER_SECOND).toBe(SERVER_MIN_RATE);
  });

  test("an abort is not reported as a failure", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isCancel(abort)).toBe(true);
    expect(isCancel(new Error("413 el archivo pasa de 15 MB"))).toBe(false);
    expect(isCancel("not an error")).toBe(false);
  });
});

/**
 * The control: origin/main's rule, which is `attachments = [...attachments, ref]` after an
 * `await` that knew nothing about whose draft it was filling. Same sequence CDP measured,
 * and the assertion is that the rule loses the file's ownership -- so this test passes with
 * the old rule and documents exactly what had to change.
 */
describe("the rule origin/main used", () => {
  test("with no ownership, a late answer attaches itself to the draft it finds", () => {
    // This is the shape that shipped: the chip row had a local `uploading` list, and the
    // `finally`/success path wrote straight into the bound `attachments`.
    let attachments: string[] = [];
    const draft: string[] = []; // what the pane shows
    const paint = (name: string) => { attachments = [...attachments, name]; };

    // The file was picked for the old conversation, which then went away.
    draft.length = 0;
    attachments = [];
    // The POST answers afterwards, with nothing to check against.
    paint("secreto-e39.png");

    // The next, unrelated message carries a file nobody picked for it. This is the body CDP
    // read off the wire: POST /api/sessions with attachments:[{name:"secreto-e39.png"}].
    expect(draft).toEqual([]);
    expect(attachments).toEqual(["secreto-e39.png"]); // <- the defect: it rode out anyway
  });

  test("the draft an upload belongs to is what makes the late answer droppable", () => {
    const state = createUploadState();
    const token = beginUpload(state, fakeFile("secreto-e39.png"));
    let attachments: string[] = [];

    abandonDraft(state); // the user moves to another conversation
    // Same arrival order: the POST answers with nothing else to check.
    if (attaches(state, token)) attachments = ["secreto-e39.png"];

    expect(attachments).toEqual([]);
  });
});

/**
 * E43: the backstop deadline, measured through the real file input with the
 * upload throttled by CDP to 30 kB/s.
 *
 * Two defects, one cause, and the second is the one a user actually meets:
 *
 * 1. The deadline was a FLAT five minutes, so it answered without asking how much
 *    was still owed. A 14,8 MB file — inside the 15 MB `ATTACH_MAX` — was aborted
 *    at t+304 s while still moving at ~30 kB/s.
 * 2. That abort was indistinguishable from the user pressing Cancel, so
 *    `isCancel` called it a cancel and the failure was painted as NOTHING. The
 *    chip disappeared and no toast ever appeared; the only trace was one
 *    `net::ERR_ABORTED canceled:true` in the network log. A file the user watched
 *    for five minutes simply stopped existing, with the app saying nothing.
 */
describe("the upload backstop (E43)", () => {
  test("the budget is the time this file needs at a working rate, not five minutes", () => {
    const fifteenMb = 15 * 1024 * 1024;
    const secondsNeededAtSlowLink = Math.ceil(fifteenMb / 30_000); // the measured rate
    expect(uploadDeadlineMs(fifteenMb)).toBeGreaterThanOrEqual(secondsNeededAtSlowLink * 1000);
    expect(uploadDeadlineMs(fifteenMb)).toBeGreaterThan(UPLOAD_DEADLINE_FLOOR_MS);
  });

  test("a small file keeps the budget it always had", () => {
    // No regression for the common case: a 200 KB photo is still 5 minutes.
    expect(uploadDeadlineMs(200_000)).toBe(UPLOAD_DEADLINE_FLOOR_MS);
    expect(uploadDeadlineMs(0)).toBe(UPLOAD_DEADLINE_FLOOR_MS);
  });

  test("the client backstop never sits below the server's own ceiling", () => {
    // Separate packages, separate constants -- which is how this shipped twice.
    // The client aborting first would pre-empt an honest server answer.
    const serverCeiling = bodyTotalSeconds(ATTACH_MAX_BYTES + 8192) * 1000;
    expect(uploadDeadlineMs(ATTACH_MAX)).toBeGreaterThanOrEqual(serverCeiling);
  });

  test("THE BUG: a deadline abort is not a cancel, so it gets reported", async () => {
    const state = createUploadState();
    const token = beginUpload(state, fakeFile("slow-e43.png"), undefined, 40);
    await new Promise((r) => setTimeout(r, 120));
    expect(token.controller.signal.aborted).toBe(true);

    // What fetch() rejects with when a signal aborts WITH A REASON.
    const reason = token.controller.signal.reason;
    // The measured symptom: this came back an AbortError, isCancel said "the
    // user changed their mind", and nothing was painted.
    expect(reason).toBeInstanceOf(UploadDeadline);
    expect(isCancel(reason)).toBe(false);
    // ...and it still reads as the app giving up, not the server refusing.
    expect((reason as UploadDeadline).name).toBe("UploadDeadline");
    expect((reason as UploadDeadline).message).toContain("did not finish within");
  });

  test("a user cancel stays silent", () => {
    const state = createUploadState();
    const token = beginUpload(state, fakeFile("a.png"));
    cancelUpload(state, token.key);
    // The chip's button aborts with no reason, so the rejection is a plain
    // AbortError and remains a cancel: the user asked, so we say nothing.
    expect(isCancel(token.controller.signal.reason ?? Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
  });
});
