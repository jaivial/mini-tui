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
  UPLOAD_DEADLINE_MS,
} from "../web/src/lib/attachmentUpload";

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
    // 15 MB (ATTACH_MAX) at 500 kbit/s is about four minutes of honest transfer, so the
    // backstop has to sit above it or it would kill a slow but working upload.
    expect(UPLOAD_DEADLINE_MS).toBeGreaterThan(4 * 60_000);
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
