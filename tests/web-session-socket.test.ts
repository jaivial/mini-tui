/** The browser-side per-session socket: reconnect, backoff, heartbeat, and giving up cleanly. */
import { describe, expect, test } from "bun:test";
import { SessionSocket, type SocketLike, type SocketState } from "../web/src/lib/session-socket";
import type { Frame } from "../web/src/lib/types";

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  // test helpers
  accept() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(frame: Frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function harness(opts: ConstructorParameters<typeof SessionSocket>[2] = {}) {
  FakeSocket.all = [];
  const frames: Frame[] = [];
  const states: [SocketState, number][] = [];
  const sock = new SessionSocket(
    "s-1",
    { frame: (f) => frames.push(f), state: (s, n) => states.push([s, n]) },
    { make: (url) => new FakeSocket(url), url: (id) => `ws://x/${id}`, baseDelay: 5, maxDelay: 20, heartbeat: 10_000, ...opts },
  );
  return { sock, frames, states, last: () => FakeSocket.all.at(-1)! };
}
const snap = (): Frame => ({ t: "snapshot", id: "s-1", session: { events: [] } as never });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SessionSocket", () => {
  test("connects to its own session's url and goes live on the first snapshot", () => {
    const h = harness();
    h.sock.open();
    expect(h.last().url).toBe("ws://x/s-1");
    h.last().accept();
    expect(h.states.at(-1)![0]).toBe("connecting"); // open alone is not proof
    h.last().push(snap());
    expect(h.states.at(-1)![0]).toBe("live");
    expect(h.frames).toHaveLength(1);
    h.sock.close();
  });

  test("reconnects after a drop and goes live again on the next snapshot", async () => {
    const h = harness();
    h.sock.open();
    h.last().accept();
    h.last().push(snap());
    h.last().drop();
    expect(h.states.at(-1)![0]).toBe("reconnecting");
    await wait(40);
    expect(FakeSocket.all).toHaveLength(2);
    h.last().accept();
    h.last().push(snap());
    expect(h.states.at(-1)).toEqual(["live", 0]);
    h.sock.close();
  });

  test("backs off: repeated failures widen the delay and count attempts", async () => {
    const h = harness({ baseDelay: 10, maxDelay: 80 });
    h.sock.open();
    h.last().drop();
    h.last().onclose; // first failure scheduled
    await wait(30);
    h.last().drop();
    await wait(60);
    expect(FakeSocket.all.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...h.states.map(([, n]) => n))).toBeGreaterThanOrEqual(2);
    h.sock.close();
  });

  test("an accepted-then-dropped socket does not reset the backoff", async () => {
    const h = harness({ baseDelay: 10, maxDelay: 80 });
    h.sock.open();
    h.last().accept();
    h.last().drop(); // accepted but never sent a snapshot
    await wait(30);
    h.last().accept();
    h.last().drop();
    await wait(5); // the retry decision is asynchronous (existence check)
    expect(Math.max(...h.states.map(([, n]) => n))).toBeGreaterThanOrEqual(2);
    h.sock.close();
  });

  test("close code 4404 (unknown session) stops for good", async () => {
    const h = harness();
    h.sock.open();
    h.last().accept();
    h.last().drop(4404);
    expect(h.states.at(-1)![0]).toBe("gone");
    await wait(40);
    expect(FakeSocket.all).toHaveLength(1);
  });

  test("a refused handshake for a deleted session stops, instead of retrying forever", async () => {
    const h = harness({ exists: async () => false });
    h.sock.open();
    h.last().drop(1006); // browsers report a 404 handshake as a plain abnormal close
    await wait(30);
    expect(h.states.at(-1)![0]).toBe("gone");
    expect(h.frames.at(-1)).toEqual({ t: "gone", id: "s-1" });
    await wait(40);
    expect(FakeSocket.all).toHaveLength(1);
  });

  test("when the existence check cannot tell (server down), it keeps retrying", async () => {
    const h = harness({ exists: async () => null });
    h.sock.open();
    h.last().drop(1006);
    await wait(40);
    expect(FakeSocket.all.length).toBeGreaterThanOrEqual(2);
    h.sock.close();
  });

  test("a socket that was live and drops retries without asking whether the session exists", async () => {
    let asked = 0;
    const h = harness({ exists: async () => (asked++, false) });
    h.sock.open();
    h.last().accept();
    h.last().push(snap());
    h.last().drop(1006);
    await wait(40);
    expect(asked).toBe(0);
    expect(FakeSocket.all.length).toBeGreaterThanOrEqual(2);
    h.sock.close();
  });

  test("a `gone` frame stops reconnecting and is passed on", async () => {
    const h = harness();
    h.sock.open();
    h.last().accept();
    h.last().push(snap());
    h.last().push({ t: "gone", id: "s-1" });
    expect(h.states.at(-1)![0]).toBe("gone");
    expect(h.frames.at(-1)!.t).toBe("gone");
    await wait(40);
    expect(FakeSocket.all).toHaveLength(1);
  });

  test("close() is final: no reconnect, and late events from the old socket are ignored", async () => {
    const h = harness();
    h.sock.open();
    const first = h.last();
    first.accept();
    h.sock.close();
    first.drop();
    await wait(40);
    expect(FakeSocket.all).toHaveLength(1);
    expect(h.states.at(-1)![0]).toBe("idle");
  });

  test("pongs are swallowed, not delivered as transcript frames", () => {
    const h = harness();
    h.sock.open();
    h.last().accept();
    h.last().push({ t: "pong", id: "s-1" });
    expect(h.frames).toHaveLength(0);
    h.sock.close();
  });

  test("resync asks the server for a snapshot, only while open", () => {
    const h = harness();
    h.sock.open();
    h.sock.resync(); // still connecting: nothing to send on
    expect(h.last().sent).toHaveLength(0);
    h.last().accept();
    h.sock.resync();
    expect(JSON.parse(h.last().sent[0]!)).toEqual({ t: "resync" });
    h.sock.close();
  });

  test("a silent half-open socket is recycled by the heartbeat", async () => {
    const h = harness({ heartbeat: 10, stale: 25, baseDelay: 5 });
    h.sock.open();
    h.last().accept();
    h.last().push(snap());
    await wait(120); // nothing else ever arrives
    expect(FakeSocket.all.length).toBeGreaterThanOrEqual(2);
    expect(h.states.some(([s]) => s === "reconnecting")).toBe(true);
    h.sock.close();
  });

  test("the heartbeat pings while traffic is fresh", async () => {
    const h = harness({ heartbeat: 10, stale: 10_000 });
    h.sock.open();
    h.last().accept();
    await wait(35);
    expect(h.last().sent.some((m) => JSON.parse(m).t === "ping")).toBe(true);
    h.sock.close();
  });
});
