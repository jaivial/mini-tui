/** The per-session transcript feed: isolation, deltas, resync and the origin guard. */
import { describe, expect, test } from "bun:test";
import { SessionFeed, sameOrigin, summarize, toWire, type Frame } from "../src/web/feed";
import type { LiveSession } from "../src/web/sessions";

function session(id: string, events: LiveSession["events"] = []): LiveSession {
  return {
    id, title: id, cwd: "/", model: "m", task: "t", target: "local", status: "running",
    events, messages: [{ role: "user", content: "secret raw model I/O" } as never], info: { cost: 0, apiCalls: 0 },
    createdAt: 1, updatedAt: 1, startedAt: 1, apiCalls: 0, cost: 0, exitStatus: "",
  };
}
const collect = () => {
  const frames: Frame[] = [];
  return { frames, send: (f: Frame) => (frames.push(f), true) };
};

describe("SessionFeed", () => {
  test("a subscriber gets a snapshot first, without the raw messages", () => {
    const feed = new SessionFeed(0);
    const a = session("a", [{ type: "task", text: "hi" }]);
    const c = collect();
    feed.subscribe(a, c.send);
    expect(c.frames).toHaveLength(1);
    const first = c.frames[0]!;
    expect(first.t).toBe("snapshot");
    expect(first.t === "snapshot" && "messages" in first.session).toBe(false);
    expect(first.t === "snapshot" && first.session.events).toHaveLength(1);
  });

  test("sessions never see each other's frames", () => {
    const feed = new SessionFeed(0);
    const a = session("a");
    const b = session("b");
    const ca = collect();
    const cb = collect();
    feed.subscribe(a, ca.send);
    feed.subscribe(b, cb.send);
    a.events.push({ type: "assistant", text: "for a only" });
    feed.publish(a);
    expect(ca.frames.at(-1)).toMatchObject({ t: "delta", id: "a", from: 0 });
    expect(cb.frames).toHaveLength(1); // only its own connect snapshot
    expect(JSON.stringify(cb.frames)).not.toContain("for a only");
  });

  test("a delta carries only the events since the last frame", () => {
    const feed = new SessionFeed(0);
    const a = session("a", [{ type: "task", text: "1" }]);
    const c = collect();
    feed.subscribe(a, c.send);
    a.events.push({ type: "assistant", text: "2" }, { type: "assistant", text: "3" });
    feed.publish(a);
    a.events.push({ type: "assistant", text: "4" });
    feed.publish(a);
    const [, d1, d2] = c.frames as Extract<Frame, { t: "delta" }>[];
    expect([d1!.from, d1!.events.length]).toEqual([1, 2]);
    expect([d2!.from, d2!.events.length]).toEqual([3, 1]);
  });

  test("a rewritten transcript resnapshots instead of sending a bogus delta", () => {
    const feed = new SessionFeed(0);
    const a = session("a", [{ type: "task", text: "1" }, { type: "task", text: "2" }]);
    const c = collect();
    feed.subscribe(a, c.send);
    a.events = [{ type: "task", text: "fresh" }];
    feed.publish(a);
    expect(c.frames.at(-1)?.t).toBe("snapshot");
  });

  test("a dropped frame forces a snapshot next, never a delta over the hole", async () => {
    const feed = new SessionFeed(0);
    const a = session("a");
    const frames: Frame[] = [];
    let drop = false;
    feed.subscribe(a, (f) => (drop ? false : (frames.push(f), true)));
    drop = true;
    a.events.push({ type: "assistant", text: "lost" });
    feed.publish(a);
    drop = false;
    a.events.push({ type: "assistant", text: "kept" });
    feed.publish(a);
    const last = frames.at(-1)!;
    expect(last.t).toBe("snapshot");
    expect(last.t === "snapshot" && last.session.events.map((e) => (e as { text: string }).text)).toEqual(["lost", "kept"]);
  });

  test("resync() replays the whole transcript on request", () => {
    const feed = new SessionFeed(0);
    const a = session("a", [{ type: "task", text: "1" }]);
    const c = collect();
    const sub = feed.subscribe(a, c.send);
    sub.resync();
    expect(c.frames.map((f) => f.t)).toEqual(["snapshot", "snapshot"]);
  });

  test("changes inside the window are merged into one frame", async () => {
    const feed = new SessionFeed(15);
    const a = session("a");
    const c = collect();
    feed.subscribe(a, c.send);
    for (let i = 0; i < 20; i++) {
      a.events.push({ type: "assistant", text: String(i) });
      feed.publish(a);
    }
    expect(c.frames).toHaveLength(1);
    await Bun.sleep(40);
    expect(c.frames).toHaveLength(2);
    expect((c.frames[1] as Extract<Frame, { t: "delta" }>).events).toHaveLength(20);
  });

  test("unsubscribe stops delivery and gone() notifies then forgets", () => {
    const feed = new SessionFeed(0);
    const a = session("a");
    const c1 = collect();
    const c2 = collect();
    const s1 = feed.subscribe(a, c1.send);
    feed.subscribe(a, c2.send);
    s1.unsubscribe();
    feed.publish(a);
    expect(c1.frames).toHaveLength(1);
    expect(feed.count("a")).toBe(1);
    feed.gone("a");
    expect(c2.frames.at(-1)).toEqual({ t: "gone", id: "a" });
    expect(feed.count("a")).toBe(0);
  });
});

describe("summaries", () => {
  test("summarize drops the transcript, toWire drops only the raw messages", () => {
    const s = session("a", [{ type: "task", text: "x" }]);
    expect("events" in summarize(s)).toBe(false);
    expect("messages" in summarize(s)).toBe(false);
    expect("events" in toWire(s)).toBe(true);
    expect("messages" in toWire(s)).toBe(false);
  });
});

describe("sameOrigin", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  test("accepts the page's own origin, and non-browser clients", () => {
    expect(sameOrigin(h({ origin: "https://mini.example.com", host: "mini.example.com" }))).toBe(true);
    expect(sameOrigin(h({ host: "mini.example.com" }))).toBe(true);
  });
  test("refuses another site", () => {
    expect(sameOrigin(h({ origin: "https://evil.example", host: "mini.example.com" }))).toBe(false);
    expect(sameOrigin(h({ origin: "not a url", host: "mini.example.com" }))).toBe(false);
  });
  test("allows the vite dev proxy (loopback to loopback) only", () => {
    expect(sameOrigin(h({ origin: "http://localhost:4318", host: "127.0.0.1:4317" }))).toBe(true);
    expect(sameOrigin(h({ origin: "http://localhost:4318", host: "mini.example.com" }))).toBe(false);
  });
});
