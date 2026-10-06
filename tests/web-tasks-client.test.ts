/** The tab's task board client on the one hub socket, against a fake socket (no network). */
import { describe, expect, test } from "bun:test";
import { HubConnection } from "../web/src/lib/hub";
import { TasksClient } from "../web/src/lib/tasksClient";

class FakeWs {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: unknown = null;
  onmessage: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;
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
    (this.onopen as () => void)();
  }
  push(m: unknown) {
    (this.onmessage as (ev: { data: string }) => void)({ data: JSON.stringify(m) });
  }
  drop() {
    this.readyState = 3;
    (this.onclose as () => void)();
  }
}

function connected() {
  const hub = new HubConnection({ url: () => "ws://hub.test/api/hub", make: (url) => new FakeWs(url) as never, baseDelay: 1, maxDelay: 2 });
  const client = new TasksClient(hub);
  return { hub, client, ws: () => FakeWs.all.at(-1)! };
}

describe("TasksClient", () => {
  test("watching sends one watch and receives the board", () => {
    const { client, ws } = connected();
    const seen: unknown[] = [];
    client.watch((tasks) => seen.push(tasks));
    const socket = ws();
    socket.open();
    expect(socket.sent.filter((m) => (m as { t: string }).t === "tasks.watch").length).toBe(1);
    socket.push({ t: "tasks", tasks: [{ id: "s-1", title: "Fix login", description: "", todos: { done: [], pending: [], left: ["x"] }, updatedAt: 5 }] });
    expect(client.list).toHaveLength(1);
    expect(client.list[0]!.title).toBe("Fix login");
    expect(seen.at(-1)).toMatchObject([{ id: "s-1" }]);
  });

  test("two readers share one watch; the watch ends with the last of them", () => {
    const { client, ws } = connected();
    const a = client.watch(() => {});
    const b = client.watch(() => {});
    const socket = ws();
    socket.open();
    expect(socket.sent.filter((m) => (m as { t: string }).t === "tasks.watch").length).toBe(1);
    a();
    expect(socket.sent.some((m) => (m as { t: string }).t === "tasks.unwatch")).toBe(false);
    b();
    expect(socket.sent.some((m) => (m as { t: string }).t === "tasks.unwatch")).toBe(true);
    expect(client.list).toEqual([]); // released: the board goes back to unknown
  });

  test("the second reader is handed the board it already missed", () => {
    const { client, ws } = connected();
    client.watch(() => {});
    const socket = ws();
    socket.open();
    socket.push({ t: "tasks", tasks: [{ id: "s-1", title: "one", description: "", todos: { done: [], pending: [], left: [] }, updatedAt: 1 }] });
    let late: unknown = null;
    client.watch((tasks) => (late = tasks));
    expect(late).toMatchObject([{ title: "one" }]);
  });

  test("on reconnect the watch goes out again and the board arrives fresh", async () => {
    const { client, ws } = connected();
    client.watch(() => {});
    const first = ws();
    first.open();
    first.push({ t: "tasks", tasks: [{ id: "s-1", title: "stale", description: "", todos: { done: [], pending: [], left: [] }, updatedAt: 1 }] });
    first.drop();
    await Bun.sleep(20); // the hub retries with jittered backoff (1-2ms here): wait for the new socket
    const second = ws();
    second.open();
    expect(second.sent.filter((m) => (m as { t: string }).t === "tasks.watch").length).toBe(1);
    second.push({ t: "tasks", tasks: [{ id: "s-1", title: "fresh", description: "", todos: { done: [], pending: [], left: [] }, updatedAt: 2 }] });
    expect(client.list[0]!.title).toBe("fresh");
  });

  test("a tab that never watches never connects", () => {
    const before = FakeWs.all.length;
    connected();
    expect(FakeWs.all.length).toBe(before);
  });
});
