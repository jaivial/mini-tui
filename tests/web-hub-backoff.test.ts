/**
 * The hub socket's reconnect policy, against sockets that OPEN and are then dropped (E50).
 *
 * Before: the hub reset its backoff on `onopen`, so an accepting-but-dropping server was hammered
 * 33 times in 3 s (measured with the deployed code) while the per-session socket — same machinery,
 * rule only in its own copy — backed off with gaps 85 → 1315 ms. Both now take the rule from
 * `Reconnect`, where `onopen` cannot reset anything.
 */
import { describe, expect, test } from "bun:test";
import { HubConnection } from "../web/src/lib/hub";
import { NotesClient, saveDeadlineMs } from "../web/src/lib/notesClient";
import type { SocketLike } from "../web/src/lib/session-socket";
import { TasksClient } from "../web/src/lib/tasksClient";
import { WorkspaceClient } from "../web/src/lib/workspaceClient";
import { TermSession } from "../web/src/lib/termClient";

/** A socket the server accepts and drops without saying anything. */
class AcceptThenDrop implements SocketLike {
  static all: AcceptThenDrop[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(readonly url: string) {
    AcceptThenDrop.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
      setTimeout(() => {
        this.readyState = 3;
        this.onclose?.({ code: 1006 });
      }, 2);
    }, 2);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

/** Same, but the server says `hello` first (what the real hub does on every connection). */
class HelloThenDrop extends AcceptThenDrop {
  constructor(url: string) {
    super(url);
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ t: "hello", limits: { noteMax: 200 } }) }), 3);
  }
}

function run<T>(cls: new (url: string) => AcceptThenDrop, ms: number): Promise<{ attempts: number; gaps: number[] }> {
  AcceptThenDrop.all = [];
  const hub = new HubConnection({
    url: () => "ws://fake/api/hub",
    make: (u) => new cls(u),
    baseDelay: 10,
    maxDelay: 40,
    heartbeat: 1e9,
    random: () => 1, // the jitter at full: delays are exactly 10, 20, 40, 40, ...
  });
  hub.send({ t: "a" });
  return new Promise((resolve) => {
    const stamps: number[] = [];
    const t0 = Date.now();
    const timer = setInterval(() => {
      while (stamps.length < AcceptThenDrop.all.length) stamps.push(Date.now() - t0);
    }, 1);
    setTimeout(() => {
      clearInterval(timer);
      hub.stop();
      const gaps = stamps.slice(1).map((at, i) => at - stamps[i]!);
      resolve({ attempts: AcceptThenDrop.all.length, gaps });
    }, ms);
  });
}

describe("the hub backs off", () => {
  test("an accepted-then-dropped socket does not reset the backoff", async () => {
    const { attempts, gaps } = await run(AcceptThenDrop, 300);
    // Backoff: 10 + 20 + 40 + 40 + ... ≈ 8 attempts in 300 ms. Without it (the old copy) every
    // retry landed at ~10 ms: ~25 attempts in the same window.
    expect(attempts).toBeLessThanOrEqual(10);
    expect(gaps.length).toBeGreaterThan(1);
    expect(Math.max(...gaps)).toBeGreaterThan(2 * Math.min(...gaps));
  });

  test("a connection that says hello has proved itself: the next failure starts over", async () => {
    const { attempts } = await run(HelloThenDrop, 300);
    // Every attempt delivered `hello`, so every retry is a first retry (10 ms): many more of them.
    expect(attempts).toBeGreaterThanOrEqual(12);
  });

  test("stop() leaves no socket and no timer behind", async () => {
    AcceptThenDrop.all = [];
    const hub = new HubConnection({ url: () => "ws://fake", make: (u) => new AcceptThenDrop(u), baseDelay: 5, maxDelay: 10, heartbeat: 1e9 });
    hub.send({ t: "a" });
    await Bun.sleep(20);
    hub.stop();
    const after = AcceptThenDrop.all.length;
    await Bun.sleep(60);
    expect(AcceptThenDrop.all.length).toBe(after);
    expect(AcceptThenDrop.all.at(-1)!.readyState).toBe(3);
  });
});

describe("a save the app reports on must match what happens to it", () => {
  class Held implements SocketLike {
    static all: Held[] = [];
    readyState = 0;
    sent: string[] = [];
    onopen: SocketLike["onopen"] = null;
    onmessage: SocketLike["onmessage"] = null;
    onclose: SocketLike["onclose"] = null;
    onerror: SocketLike["onerror"] = null;
    constructor(readonly url: string) {
      Held.all.push(this);
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.onopen?.({});
    }
  }
  function setup() {
    Held.all = [];
    const hub = new HubConnection({ url: () => "ws://fake", make: (u) => new Held(u) as never, baseDelay: 5, maxDelay: 10, heartbeat: 1e9 });
    return { hub, notes: new NotesClient(hub) };
  }

  test("a save that never went out is withdrawn: after the failure it is never sent", async () => {
    const { hub, notes } = setup();
    const outcome = notes.save("n-1", "text", 0, 40).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    await Bun.sleep(60); // the deadline fires while the message is still queued (no socket)
    const message = await outcome;
    expect(message).toContain("never sent");
    const ws = Held.all.at(-1)!;
    ws.open(); // the connection comes back after the app reported the failure
    await Bun.sleep(10);
    expect(ws.sent.filter((raw) => raw.includes("note.save"))).toEqual([]);
    hub.stop();
  });

  test("a save already out cannot be withdrawn, and says so instead of claiming a failure", async () => {
    const { hub, notes } = setup();
    const outcome = notes.save("n-1", "text", 0, 40).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    const ws = Held.all.at(-1)!;
    ws.open(); // the save goes out at once
    await Bun.sleep(80);
    const message = await outcome;
    expect(message).toContain("no answer");
    expect(message).toContain("may still be applied");
    hub.stop();
  });

  test("the deadline outlasts the payload it carries (a flat 15 s could cut a big note in flight)", () => {
    expect(saveDeadlineMs(0)).toBe(15_000);
    expect(saveDeadlineMs(200_000)).toBeGreaterThan(60_000);
    expect(saveDeadlineMs(200_000)).toBe(saveDeadlineMs(200_000, 15_000));
  });

  test("a save that answered before the deadline settles normally and records its version", async () => {
    const { hub, notes } = setup();
    const p = notes.save("n-1", "text", 0);
    const ws = Held.all.at(-1)!;
    ws.open();
    const req = JSON.parse(ws.sent.at(-1)!) as { req: number };
    ws.onmessage?.({ data: JSON.stringify({ t: "note.saved", req: req.req, note: { id: "n-1", body: "text", updatedAt: 7 } }) });
    expect(await p).toEqual({ ok: true, note: { id: "n-1", body: "text", updatedAt: 7 } });
    expect(notes.ourVersions["n-1"]).toBe(7);
    hub.stop();
  });

  test("a late answer for a save the app gave up on still records the version it established", async () => {
    const { hub, notes } = setup();
    const outcome = notes.save("n-1", "text", 0, 30).catch((e: Error) => e.message);
    const ws = Held.all.at(-1)!;
    ws.open();
    const req = JSON.parse(ws.sent.at(-1)!) as { req: number };
    await Bun.sleep(60); // the app gave up
    expect(await outcome).toContain("may still be applied");
    // ...and only then the server answers. The write landed: the next save must name its version.
    ws.onmessage?.({ data: JSON.stringify({ t: "note.saved", req: req.req, note: { id: "n-1", body: "text", updatedAt: 4 } }) });
    expect(notes.ourVersions["n-1"]).toBe(4);
    hub.stop();
  });
});

describe("every kind the connect hook re-sends", () => {
  class Queued implements SocketLike {
    static all: Queued[] = [];
    readyState = 0;
    sent: any[] = [];
    onopen: SocketLike["onopen"] = null;
    onmessage: SocketLike["onmessage"] = null;
    onclose: SocketLike["onclose"] = null;
    onerror: SocketLike["onerror"] = null;
    constructor(readonly url: string) {
      Queued.all.push(this);
    }
    send(data: string) {
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.onopen?.({});
    }
  }

  test("goes out exactly once on connect, and the queue is not read from its own text", () => {
    // The old flush dropped queued messages by sniffing their JSON for `"t":"note.watch"` and
    // `"t":"tasks.watch"` — two of the FOUR kinds the connect hooks re-send. `ws.watch` and
    // `term.open` went out twice (measured against the deployed code), and a `term.open` twice is
    // two shells. Now the re-send is declared where the message is sent, and the flush is structural.
    Queued.all = [];
    const conn = new HubConnection({ url: () => "ws://fake", make: (u) => new Queued(u) as never, baseDelay: 5, maxDelay: 10, heartbeat: 1e9 });
    new NotesClient(conn).watch("n-1", () => {});
    new TasksClient(conn).watch(() => {});
    new WorkspaceClient(conn);
    new TermSession(conn, "t-1", null, { opened() {}, data() {}, exit() {}, error() {} }).open(80, 24);
    const ws = Queued.all[0]!;
    expect(ws.sent).toEqual([]); // all four are waiting for the connection
    ws.open();
    for (const t of ["note.watch", "tasks.watch", "ws.watch", "term.open"]) {
      expect(ws.sent.filter((m) => m.t === t).map((m) => m.t), `${t} must go out exactly once`).toHaveLength(1);
    }
    conn.stop();
  });
});
