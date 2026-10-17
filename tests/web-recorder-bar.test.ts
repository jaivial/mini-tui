/**
 * E21: the audio prompt bar, as rules.
 *
 * Measured in Chrome 145 against the deployed build (`index-CRXhCKGk.js`) with a real
 * `MediaRecorder` take and a real failed `POST /api/attachments` (CDP `Fetch`, 503). The
 * component decided what to paint from booleans about the LIVE microphone, so it had no
 * notion of "a take exists": a take that had stopped — at the 5-minute cap, or after a
 * failed upload — could not be sent at all. Five minutes of the user's voice, two buttons,
 * neither of them "send".
 *
 * Only the rules are asserted here; the components are DOM. Each test names the defect it
 * would otherwise ship, and the state names are the machine's own (`idle` / `requesting` /
 * `recording` / `recorded` / `submitting` / `error`).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { recorderBarView, recorderCanDiscard, recorderHasTake, type RecorderState } from "../web/src/lib/recorderBar";

const view = (state: RecorderState, error: Error | null = null) => recorderBarView({ state, error });

describe("recorderBarView: a STOPPED take can still be sent", () => {
  test("`recorded` offers the send button — the 5-minute cap lands here", () => {
    // Measured: after 300.3 s of real recording the row had NO submit button and the only
    // controls were "Descartar la nota de voz" and a mic labelled "Nota de voz lista".
    expect(view("recorded").showSubmit).toBe(true);
    expect(view("recorded").submitDisabled).toBe(false);
  });

  test("`recorded` keeps its length on screen, so the user can see what they have", () => {
    expect(view("recorded").showDuration).toBe(true);
    expect(view("recorded").status).toBe("Nota de voz lista");
  });

  test("`recorded` hides the mic: a second take is the discard button's business", () => {
    // Otherwise pressing the mic starts a new take and the old blob is dropped by
    // `clearActiveRecording()` with no warning.
    expect(view("recorded").showTrigger).toBe(false);
    expect(view("recorded").showCancel).toBe(true);
  });

  test("the send button is present in every state that holds a take", () => {
    for (const state of ["recording", "recorded"] as RecorderState[]) {
      expect(view(state).showSubmit).toBe(true);
    }
  });

  test("a failed upload keeps the send button, so the take can be retried", () => {
    // The machine parks a failed submit back in `recorded` WITH the blob; the button has
    // to be there, or the retry does not exist.
    const failed = view("recorded", new Error("No se pudo adjuntar la nota de voz"));
    expect(failed.showSubmit).toBe(true);
    expect(failed.statusIsError).toBe(true);
    expect(failed.status).toBe("No se pudo adjuntar la nota de voz");
  });

  test("`submitting` disables both ends of the row, so nothing double-fires", () => {
    const busy = view("submitting");
    expect(busy.showSubmit).toBe(true);
    expect(busy.submitDisabled).toBe(true);
    expect(busy.cancelLabel).toBe("Descartar la nota de voz");
    expect(busy.meterActive).toBe(false);
  });
});

describe("recorderBarView: focus and keyboard", () => {
  test("the trigger keeps Control UI's rule: disabled while the mic is busy", () => {
    // The trigger STARTS a take; the Check beside it stops and sends it. Disabling it is
    // upstream's contract, so the fix is not to un-disable it.
    expect(view("recording").triggerDisabled).toBe(true);
    expect(view("submitting").triggerDisabled).toBe(true);
    expect(view("idle").triggerDisabled).toBe(false);
  });

  test("but the send button APPEARS in the very state that disables the trigger", () => {
    // This is the whole focus bug: `triggerDisabled` and `showSubmit` flip in the same
    // tick, so the element holding focus is disabled and the one that replaces it never
    // takes it. Measured: `activeElement === BODY` right after Enter started recording.
    const started = view("recording");
    expect(started.triggerDisabled).toBe(true);
    expect(started.showSubmit).toBe(true);
  });

  test("Escape has something to throw away in every live state, and none when idle", () => {
    for (const state of ["requesting", "recording", "recorded", "error"] as RecorderState[]) {
      expect(view(state).canDiscard).toBe(true);
    }
    expect(view("idle").canDiscard).toBe(false);
    expect(view("submitting").canDiscard).toBe(false);
  });

  test("the meter animates only while the microphone is actually open", () => {
    expect(view("recording").meterActive).toBe(true);
    expect(view("requesting").meterActive).toBe(true);
    expect(view("recorded").meterActive).toBe(false);
    expect(view("idle").meterActive).toBe(false);
  });

  test("an idle bar is empty: no status, no length, no second button", () => {
    const idle = view("idle");
    expect(idle.status).toBe("");
    expect(idle.showSubmit).toBe(false);
    expect(idle.showCancel).toBe(false);
    expect(idle.showDuration).toBe(false);
    expect(idle.showTrigger).toBe(true);
  });
});

describe("recorderBarView: the error states read as errors", () => {
  test("a permission failure shows the machine's own sentence, in the error tone", () => {
    const denied = view("error", new Error("Microphone access is blocked. Allow it in your browser's site settings, then try again."));
    expect(denied.statusIsError).toBe(true);
    expect(denied.status).toContain("Microphone access is blocked");
    expect(denied.cancelLabel).toBe("Descartar y volver a grabar");
    expect(denied.cancelIsRetry).toBe(true);
    expect(denied.showTrigger).toBe(true);
  });

  test("a kept take after a failed upload says DESCARTAR, not re-record", () => {
    // Nothing was re-recorded: the blob is right there. The icon and the label have to
    // agree — a screenshot caught them disagreeing (retry arrow + "Descartar la nota").
    const failed = view("recorded", new Error("disco lleno"));
    expect(failed.cancelLabel).toBe("Descartar la nota de voz");
    expect(failed.cancelIsRetry).toBe(false);
  });

  test("an error with no reason still says something", () => {
    expect(view("error").status).toBe("No se pudo grabar");
    expect(view("error").statusIsError).toBe(true);
  });
});

describe("the predicates the component asks before destroying anything", () => {
  test("a take exists only once it has stopped and not yet been sent", () => {
    expect(recorderHasTake("recorded")).toBe(true);
    expect(recorderHasTake("recording")).toBe(false);
    expect(recorderHasTake("submitting")).toBe(false);
    expect(recorderHasTake("idle")).toBe(false);
  });

  test("the outer toggle may only close the panel when nothing would be lost", () => {
    // Measured: 1.5 s recorded, click the composer's mic → panel and take both gone,
    // 0 toasts. Unmounting the recorder runs `destroy()` → `cancelInternal(false)`.
    expect(recorderCanDiscard("recording")).toBe(true);
    expect(recorderCanDiscard("recorded")).toBe(true);
    expect(recorderCanDiscard("idle")).toBe(false);
    expect(recorderCanDiscard("submitting")).toBe(false);
  });
});

describe("the component must not recompute these rules from the live microphone", () => {
  test("the send button is NOT gated on the live microphone", () => {
    // The defect itself, pinned in the source that shipped it: `{#if live}` around the
    // submit button. `live` is `recording || requesting`, so a take that had STOPPED — at
    // the 5-minute cap, or after a failed upload — rendered no way to send it. Measured
    // against the deployed build: 300.3 s of real recording, two buttons, neither "send".
    const src = readFileSync(join(import.meta.dir, "../web/src/lib/components/control-ui/AudioRecorder.svelte"), "utf8");
    expect(src).not.toMatch(/\{#if live\}[\s\S]{0,200}data-slot="submit"/);
  });

  test("Escape is bound, so the microphone is not left open", () => {
    // Measured: with the state at `recording`, Escape left it at `recording`.
    const src = readFileSync(join(import.meta.dir, "../web/src/lib/components/control-ui/AudioRecorder.svelte"), "utf8");
    expect(src).toContain('event.key !== "Escape"');
    expect(src).toMatch(/onkeydown=\{onKeydown\}/);
  });

  test("the composer's outer mic asks before destroying a take", () => {
    // Measured: 1.5 s recorded, click the composer's mic → panel and take both gone,
    // 0 toasts. The toggle used to be `recordingOpen = !recordingOpen`, and unmounting
    // the recorder runs `destroy()` → `cancelInternal(false)`.
    const src = readFileSync(join(import.meta.dir, "../web/src/lib/components/Composer.svelte"), "utf8");
    expect(src).toContain("onclick={toggleRecording}");
    expect(src).not.toMatch(/onclick=\{\(\) => \(recordingOpen = !recordingOpen\)\}/);
  });

  test("the template reads the view, never a `$derived` over the machine's getters", () => {
    // Svelte cannot see a getter change, so `$derived(recorder.state)` freezes at its
    // first value: E20 hit exactly this with the rename field and its tests passed 20/20
    // with the bug inside. This pins the shape that keeps the bar honest.
    const src = readFileSync(join(import.meta.dir, "../web/src/lib/components/control-ui/AudioRecorder.svelte"), "utf8");
    expect(src).toContain("recorderBarView(");
    expect(src).not.toMatch(/\$derived\(\s*recorder\./);
    expect(src).not.toMatch(/\$derived\([^)]*recorder\.state/);
  });

  test("the component still hands a failed upload back to the machine", () => {
    // `attachRecording` used to swallow the error, so `submitRecording` saw a RESOLVED
    // promise and reset to `idle` with `recording: undefined`: the take was gone and
    // nothing on screen said so. Measured with a 503: state `idle`, 0 attachments.
    const src = readFileSync(join(import.meta.dir, "../web/src/lib/components/Composer.svelte"), "utf8");
    const body = src.slice(src.indexOf("async function attachRecording"), src.indexOf("function onDrop"));
    expect(body).toMatch(/catch \(error\)[\s\S]*throw error;/);
  });
});
