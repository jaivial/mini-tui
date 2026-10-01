/** The shared workspace: the server's versioned store, the hub protocol, and the browser client. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../src/web/workspace";
import { Hub, type HubClient, type HubOut } from "../src/web/hub";
import { WorkspaceClient } from "../web/src/lib/workspaceClient";

/** Saves go out at the end of the tick (several parts as one version). */
const tick = () => new Promise<void>((r) => queueMicrotask(r));

const notes = { get: (id: string) => ({ id, body: "", updatedAt: 0 }), save: () => ({ ok: true as const, note: { id: "x", body: "", updatedAt: 1 } }) };

function server() {
  const dir = mkdtempSync(join(tmpdir(), "mt-ws-"));
  const store = new WorkspaceStore(join(dir, "web-workspace.json"));
  const hub = new Hub(notes as never, 1000);
  hub.workspace = { get: () => store.get(), save: (d, b) => store.save(d, b), max: 4096 };
  return { dir, store, hub, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A browser tab: a hub client wired to a WorkspaceClient, delivering messages synchronously. */
function tab(hub: Hub) {
  const listeners = new Set<(m: any) => void>();
  const connects = new Set<() => void>();
  let online = true;
  const outbox: string[] = [];
  const client: HubClient = { send: (m: HubOut) => (online ? (listeners.forEach((l) => l(m)), true) : false) };
  hub.join(client);
  const ws = new WorkspaceClient({
    send: (m) => (online ? hub.handle(client, JSON.stringify(m)) : outbox.push(JSON.stringify(m))),
    on: (l) => (listeners.add(l), () => listeners.delete(l)),
    onConnect: (fn) => (connects.add(fn), () => connects.delete(fn)),
  });
  return {
    ws,
    offline: () => (online = false),
    reconnect: () => {
      online = true;
      connects.forEach((fn) => fn());
      for (const raw of outbox.splice(0)) if (!raw.includes('"ws.watch"')) hub.handle(client, raw);
    },
  };
}

describe("WorkspaceStore", () => {
  test("starts empty, then each save is a new version written to disk", () => {
    const s = server();
    try {
      expect(s.store.get()).toMatchObject({ version: 0, doc: null });
      const r = s.store.save({ a: 1 }, 0);
      expect(r).toMatchObject({ ok: true, workspace: { version: 1, doc: { a: 1 } } });
      expect(JSON.parse(readFileSync(join(s.dir, "web-workspace.json"), "utf8"))).toMatchObject({ version: 1, doc: { a: 1 } });
      // A fresh store (a server restart) reads it back.
      expect(new WorkspaceStore(join(s.dir, "web-workspace.json")).get()).toMatchObject({ version: 1, doc: { a: 1 } });
    } finally {
      s.done();
    }
  });
  test("a save from an old version is refused with the current value", () => {
    const s = server();
    try {
      s.store.save({ a: 1 }, 0);
      expect(s.store.save({ a: 2 }, 0)).toMatchObject({ ok: false, current: { version: 1, doc: { a: 1 } } });
    } finally {
      s.done();
    }
  });
});

describe("the workspace over the hub", () => {
  test("two tabs see the same thing: a change in one is pushed to the other", async () => {
    const s = server();
    try {
      const a = tab(s.hub);
      const b = tab(s.hub);
      expect(a.ws.ready && b.ws.ready).toBe(true);
      const seen: unknown[] = [];
      b.ws.onRemote((doc) => seen.push(doc.panes));
      a.ws.save("panes", { layout: "two panes" });
      await tick();
      expect(seen).toEqual([{ layout: "two panes" }]);
      expect(b.ws.doc).toMatchObject({ panes: { layout: "two panes" } });
      expect(a.ws.version).toBe(1);
      expect(b.ws.version).toBe(1);
    } finally {
      s.done();
    }
  });
  test("a tab opened later starts from what is saved, not from its own defaults", async () => {
    const s = server();
    try {
      tab(s.hub).ws.save("windows", { list: ["w1", "w2"] });
      await tick();
      const late = tab(s.hub);
      expect(late.ws.doc).toMatchObject({ windows: { list: ["w1", "w2"] } });
    } finally {
      s.done();
    }
  });
  test("parts merge: saving the sidebar keeps the panes", async () => {
    const s = server();
    try {
      const a = tab(s.hub);
      a.ws.save("panes", { p: 1 });
      a.ws.save("sidebar", { view: "folder" });
      await tick();
      expect(s.store.get().version).toBe(1); // one version for both
      expect(s.store.get().doc).toEqual({ panes: { p: 1 }, sidebar: { view: "folder" } });
    } finally {
      s.done();
    }
  });
  test("a stale save loses: the tab adopts the newer layout instead of overwriting it", async () => {
    const s = server();
    try {
      const a = tab(s.hub);
      const b = tab(s.hub);
      b.offline();
      a.ws.save("panes", { from: "a" }); // version 1, b does not hear of it
      await tick();
      b.ws.save("panes", { from: "b" }); // queued offline, based on version 0
      await tick();
      const adopted: unknown[] = [];
      b.ws.onRemote((doc) => adopted.push(doc.panes));
      b.reconnect();
      expect(s.store.get()).toMatchObject({ version: 1, doc: { panes: { from: "a" } } });
      expect(b.ws.doc).toMatchObject({ panes: { from: "a" } });
      expect(adopted).toEqual([{ from: "a" }]);
    } finally {
      s.done();
    }
  });
  test("an unchanged part is not saved again", async () => {
    const s = server();
    try {
      const a = tab(s.hub);
      a.ws.save("panes", { p: 1 });
      await tick();
      a.ws.save("panes", { p: 1 });
      await tick();
      expect(s.store.get().version).toBe(1);
    } finally {
      s.done();
    }
  });
  test("an oversized workspace is refused, and nothing is written", async () => {
    const s = server();
    try {
      const a = tab(s.hub);
      a.ws.save("panes", { big: "x".repeat(10_000) });
      await tick();
      expect(s.store.get().version).toBe(0);
    } finally {
      s.done();
    }
  });
  test("a device that opens the app adopts the saved workspace, its own layout does not overwrite it", async () => {
    const s = server();
    try {
      tab(s.hub).ws.saveParts({ windows: { list: ["shared"] }, panes: { p: "shared" } });
      await tick();
      // A second device whose own layout was changed before the server answered.
      const listeners = new Set<(m: any) => void>();
      const connects = new Set<() => void>();
      const client = { send: (m: any) => (listeners.forEach((l) => l(m)), true) };
      s.hub.join(client);
      const held: string[] = [];
      let connected = false;
      const ws = new WorkspaceClient({
        send: (m) => (connected ? s.hub.handle(client, JSON.stringify(m)) : held.push(JSON.stringify(m))),
        on: (l) => (listeners.add(l), () => listeners.delete(l)),
        onConnect: (fn) => (connects.add(fn), () => connects.delete(fn)),
      });
      ws.saveParts({ panes: { p: "local" }, sidebar: { view: "folder" } }); // before the first answer
      const adopted: unknown[] = [];
      ws.onRemote((d) => adopted.push(d.panes));
      connected = true;
      connects.forEach((fn) => fn());
      await tick();
      expect(ws.doc).toMatchObject({ panes: { p: "shared" } });
      expect(adopted).toEqual([{ p: "shared" }]);
      // The server keeps its panes; the part it did not have (the sidebar) is seeded.
      expect(s.store.get().doc).toEqual({ windows: { list: ["shared"] }, panes: { p: "shared" }, sidebar: { view: "folder" } });
    } finally {
      s.done();
    }
  });
});
