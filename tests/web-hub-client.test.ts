/** The tab's one hub socket and the notes client on it, against a fake socket (no network). */
import { describe, expect, test } from "bun:test";
import { HubConnection } from "../web/src/lib/hub";

class FakeWs {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen: any = null;
  onmessage: any = null;
  onclose: any = null;
  onerror: any = null;
  constructor(readonly url: string) {
    FakeWs.all.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

/** Make the client connect (it does on its first send) and open the socket, with a clean send log. */
function connect(n: any) {
  const release = n.watch("__warm", () => {});
  const ws = FakeWs.all.at(-1)!;
  ws.open();
  release();
  ws.sent.length = 0;
  return ws;
}

function make() {
  FakeWs.all = [];
  const conn = new HubConnection({ url: () => "ws://x/api/hub", make: (u) => new FakeWs(u) as any, baseDelay: 1, maxDelay: 2, heartbeat: 1e9 });
  return conn;
}

// The store wraps this with Svelte runes; the logic lives in a plain module.
const { NotesClient } = await import("../web/src/lib/notesClient");

describe("hub connection", () => {
  test("does not connect until a note is watched; then there is exactly one socket", () => {
    const conn = make();
    const n = new NotesClient(conn);
    expect(FakeWs.all.length).toBe(0); // a tab that never opens notes holds no hub socket
    n.watch("s-1", () => {});
    n.watch("s-2", () => {});
    expect(FakeWs.all.length).toBe(1);
    expect(FakeWs.all[0]!.url).toBe("ws://x/api/hub");
  });
  test("messages sent before it opens are queued and go out in order once open", () => {
    const conn = make();
    conn.send({ t: "a" });
    conn.send({ t: "b" });
    const ws = FakeWs.all[0]!;
    expect(ws.sent).toEqual([]);
    ws.open();
    expect(ws.sent.map((m) => m.t)).toEqual(["a", "b"]);
  });
  test("a dropped socket reconnects by itself", async () => {
    const conn = make();
    conn.send({ t: "a" });
    FakeWs.all[0]!.open();
    FakeWs.all[0]!.drop();
    expect(conn.state).toBe("reconnecting");
    await Bun.sleep(20);
    expect(FakeWs.all.length).toBe(2);
    FakeWs.all[1]!.open();
    expect(conn.state).toBe("live");
  });
});

describe("notes client", () => {
  test("watch sends one watch per note, shared by every holder, and unwatches after the last", () => {
    const conn = make();
    const n = new NotesClient(conn);
    const a: any[] = [], b: any[] = [];
    const ra0 = n.watch("warm", () => {});
    const ws = FakeWs.all[0]!;
    ws.open();
    ra0();
    ws.sent.length = 0;
    const ra = n.watch("s-1", (v) => a.push(v));
    const rb = n.watch("s-1", (v) => b.push(v));
    expect(ws.sent.filter((m) => m.t === "note.watch")).toEqual([{ t: "note.watch", id: "s-1" }]);
    ws.push({ t: "note", note: { id: "s-1", body: "hi", updatedAt: 5 } });
    expect(a.at(-1).body).toBe("hi");
    expect(b.at(-1).body).toBe("hi");
    ra();
    expect(ws.sent.some((m) => m.t === "note.unwatch")).toBe(false);
    rb();
    expect(ws.sent.at(-1)).toEqual({ t: "note.unwatch", id: "s-1" });
  });
  test("a second holder gets the value it missed at once", () => {
    const conn = make();
    const n = new NotesClient(conn);
    const ws0 = connect(n);
    n.watch("s-1", () => {});
    ws0.push({ t: "note", note: { id: "s-1", body: "cached", updatedAt: 2 } });
    const late: any[] = [];
    n.watch("s-1", (v) => late.push(v));
    expect(late).toEqual([{ id: "s-1", body: "cached", updatedAt: 2 }]);
  });
  test("after a reconnect every watched note is watched again (and so re-sent by the server)", async () => {
    const conn = make();
    const n = new NotesClient(conn);
    const ws0 = connect(n);
    n.watch("s-1", () => {});
    n.watch("s-2", () => {});
    ws0.drop();
    await Bun.sleep(20);
    const ws2 = FakeWs.all[1]!;
    ws2.open();
    expect(ws2.sent.filter((m) => m.t === "note.watch").map((m) => m.id).sort()).toEqual(["s-1", "s-2"]);
  });
  test("a watch made while offline goes out once, not twice, on connect", () => {
    const conn = make();
    const n = new NotesClient(conn);
    n.watch("s-1", () => {});
    const ws = FakeWs.all[0]!;
    ws.open();
    expect(ws.sent.filter((m) => m.t === "note.watch").length).toBe(1);
  });
  test("save resolves with the answer to its own request, conflicts included", async () => {
    const conn = make();
    const n = new NotesClient(conn);
    const ws = connect(n);
    const p1 = n.save("s-1", "mine", 0);
    const p2 = n.save("s-1", "again", 0);
    const [r1, r2] = ws.sent.filter((m) => m.t === "note.save");
    ws.push({ t: "note.conflict", req: r2.req, current: { id: "s-1", body: "theirs", updatedAt: 9 } });
    ws.push({ t: "note.saved", req: r1.req, note: { id: "s-1", body: "mine", updatedAt: 8 } });
    expect(await p1).toEqual({ ok: true, note: { id: "s-1", body: "mine", updatedAt: 8 } });
    expect(await p2).toEqual({ ok: false, conflict: { id: "s-1", body: "theirs", updatedAt: 9 } });
  });
  test("a server error for a save rejects it with the reason; no answer at all times out", async () => {
    const conn = make();
    const n = new NotesClient(conn);
    const ws = connect(n);
    const p = n.save("s-1", "x", 0);
    ws.push({ t: "error", req: ws.sent.at(-1).req, error: "a note can hold at most 10 characters" });
    await expect(p).rejects.toThrow(/at most 10/);
    await expect(n.save("s-1", "x", 0, 20)).rejects.toThrow(/no answer/);
  });
  test("your own save is not echoed back to your listeners as if it came from elsewhere", () => {
    const conn = make();
    const n = new NotesClient(conn);
    const ws = connect(n);
    const heard: any[] = [];
    n.watch("s-1", (v) => heard.push(v));
    void n.save("s-1", "mine", 0);
    ws.push({ t: "note.saved", req: ws.sent.at(-1).req, note: { id: "s-1", body: "mine", updatedAt: 3 } });
    expect(heard).toEqual([]);
    expect(n.values["s-1"]!.body).toBe("mine");
  });
});
