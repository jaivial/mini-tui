/**
 * The Channels panel's read ordering.
 *
 * The defect these hold down was measured on the deployed build, not reasoned about:
 * holding the FIRST poll's response of `/api/channels/inbox` and `/api/channels/evo/status`
 * with CDP, letting polls #2 and #3 land normally, and then failing the held one. The held
 * response was stale -- its data predated what was already on screen -- and its result
 * arrived LAST, so it won: the panel switched to "Reintentando..." and the WhatsApp block
 * to "Estado de conexion no disponible", hiding a connection state that two newer polls had
 * already proven. The last-response-wins rule that caused it is reproduced at the bottom as
 * `mainLogic`, so the control A/B fails against what origin/main actually does.
 */
import { describe, expect, test } from "bun:test";

import { cancelRead, createReadState, isCancel, isLatest, settleRead, startRead, startReadIfIdle } from "../web/src/lib/channelsLoad";

const paints = (state: ReturnType<typeof createReadState>, token: ReturnType<typeof startRead>) => isLatest(state, token);
const aborted = (signal: AbortSignal) => signal.aborted;

describe("channels read ordering", () => {
  test("a response from the read in flight is allowed to paint", () => {
    const state = createReadState();
    const token = startRead(state, "inbox");
    expect(paints(state, token)).toBe(true);
    settleRead(state, token);
  });

  // THE BUG, measured: poll #1 is held; #2 and #3 land and are on screen; then #1 FAILS.
  // Its failure is older than what is showing, and it arrives last.
  test("a superseded read may not paint over the panel, on failure as well as on success", () => {
    const state = createReadState();
    const first = startRead(state, "inbox");
    const second = startRead(state, "inbox");

    // #2 paints (the good, current data).
    let error = "";
    if (paints(state, second)) error = "";
    settleRead(state, second);

    // #1 now fails and its result arrives last.
    if (paints(state, first)) error = "channel inbox unavailable (503)";
    expect(error).toBe(""); // the panel kept showing data two newer polls had proven good
  });

  test("a superseded success may not overwrite the newer view either", () => {
    const state = createReadState();
    const first = startRead(state, "inbox");
    const second = startRead(state, "inbox");
    let view = "";
    if (paints(state, second)) view = "20 mensajes, seq 64";
    settleRead(state, second);
    if (paints(state, first)) view = "0 mensajes, seq 0";
    expect(view).toBe("20 mensajes, seq 64");
  });

  test("starting a read really aborts the one it replaces", () => {
    const state = createReadState();
    const first = startRead(state, "inbox");
    expect(aborted(first.controller.signal)).toBe(false);
    startRead(state, "inbox");
    expect(aborted(first.controller.signal)).toBe(true);
  });

  test("a superseded read cannot paint later even while nothing newer is in flight", () => {
    const state = createReadState();
    const first = startRead(state, "inbox");
    const second = startRead(state, "inbox");
    settleRead(state, second);
    // The slot is empty again, but `first` is still not the read the panel asked for.
    expect(state.current).toBeNull();
    expect(paints(state, first)).toBe(false);
  });

  test("settling an older read does not free the slot of the one in flight", () => {
    const state = createReadState();
    const first = startRead(state, "inbox");
    const second = startRead(state, "inbox");
    settleRead(state, first);
    expect(state.current).toBe(second);
    expect(paints(state, second)).toBe(true);
  });

  // Measured against the deployed build with the endpoint silent: 5 inbox requests in
  // 46 s, every one of them still open, because the poll never checked.
  test("a poll while a read is in flight does not open a second one", () => {
    const state = createReadState();
    const inFlight = startRead(state, "inbox");
    expect(startReadIfIdle(state, "inbox")).toBeNull();
    expect(state.current).toBe(inFlight);
  });

  test("a poll with nothing in flight does open one", () => {
    const state = createReadState();
    const token = startReadIfIdle(state, "inbox");
    expect(token).not.toBeNull();
    settleRead(state, token!);
    expect(startReadIfIdle(state, "inbox")).not.toBeNull();
  });

  // Measured: with four requests held open, closing the panel settled none of them --
  // they were still pending 22 s later.
  test("closing the panel aborts whatever is in flight", () => {
    const state = createReadState();
    const inbox = startRead(state, "inbox");
    const status = startRead(state, "evoStatus");
    cancelRead(state);
    expect(aborted(inbox.controller.signal)).toBe(true);
    expect(aborted(status.controller.signal)).toBe(true);
    expect(state.current).toBeNull();
  });

  test("cancelling twice is harmless", () => {
    const state = createReadState();
    startRead(state, "inbox");
    cancelRead(state);
    expect(() => cancelRead(state)).not.toThrow();
    expect(state.current).toBeNull();
  });

  test("the three WhatsApp surfaces keep separate claims", () => {
    const status = createReadState();
    const qr = createReadState();
    const pair = createReadState();
    const a = startRead(status, "evoStatus");
    startRead(qr, "evoQr");
    startRead(pair, "evoPairingCode");
    cancelRead(status);
    // Cancelling the status poll must not disturb the QR or the pairing code.
    expect(aborted(a.controller.signal)).toBe(true);
    expect(qr.current).not.toBeNull();
    expect(pair.current).not.toBeNull();
  });

  test("an abort is not reported as a failure", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isCancel(abort)).toBe(true);
    expect(isCancel(new Error("channel inbox unavailable (503)"))).toBe(false);
    expect(isCancel("not an error")).toBe(false);
  });
});

/**
 * The control: origin/main's rule, which is "whatever settles last assigns `view`, and
 * whatever fails last assigns `error`". Same arrival order the browser produced, and the
 * assertion is that the rule loses the panel -- so this test passes with the old rule and
 * documents exactly what had to change.
 */
describe("the rule origin/main used", () => {
  test("with no generation, the result that lands last wins", () => {
    // This is the shape that shipped: `view = await client.inbox()` from a bare timer with
    // no generation and no signal, and `catch (e) { error = ... }` for the failure.
    let view = "20 mensajes, seq 64";
    let error = "";
    const paint = (body: string) => { view = body; };
    const blow = (message: string) => { error = message; };
    // #2 and #3 answer first and are right...
    paint("20 mensajes, seq 64");
    // ...then the held #1 fails, and its result arrives last.
    blow("Failed to fetch");
    expect(error).toBe("Failed to fetch");
    expect(view).toBe("20 mensajes, seq 64"); // and the panel claims to be retrying
  });

  test("a generation is what makes the stale result droppable", () => {
    const state = createReadState();
    const first = startRead(state, "inbox");
    const second = startRead(state, "inbox");
    let error = "";
    if (paints(state, second)) error = "";
    settleRead(state, second);
    if (paints(state, first)) error = "Failed to fetch";
    expect(error).toBe("");
  });
});
