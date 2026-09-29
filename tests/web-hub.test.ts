/** The socket hub's rules, without a network: watch, push, save, conflict, cleanup. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

const dir = mkdtempSync(join(tmpdir(), "minitui-hub-"));
const savedResume = process.env.MINITUI_RESUME_DIR;
process.env.MINITUI_RESUME_DIR = join(dir, "resume");
afterAll(() => {
  if (savedResume === undefined) delete process.env.MINITUI_RESUME_DIR;
  else process.env.MINITUI_RESUME_DIR = savedResume;
  rmSync(dir, { recursive: true, force: true });
});
const { openDb, getNote, saveNote } = await import("../src/sessions");
const { Hub } = await import("../src/web/hub");

function setup(max = 1000) {
  const db = openDb(join(dir, `${crypto.randomUUID()}.db`));
  const hub = new Hub({ get: (id) => getNote(db, id), save: (id, body, base) => saveNote(db, id, body, base) }, max);
  const client = () => {
    const got: any[] = [];
    const c = { got, send: (m: any) => (got.push(m), true) };
    hub.join(c);
    return c;
  };
  return { hub, client, db };
}
const send = (hub: any, c: any, m: unknown) => hub.handle(c, JSON.stringify(m));

describe("hub", () => {
  test("joining says hello with the limits", () => {
    const { client } = setup(1234);
    expect(client().got[0]).toEqual({ t: "hello", limits: { noteMax: 1234 } });
  });
  test("watching a note sends its current value at once", () => {
    const { hub, client, db } = setup();
    saveNote(db, "s-1", "existing");
    const a = client();
    send(hub, a, { t: "note.watch", id: "s-1" });
    expect(a.got.at(-1)).toMatchObject({ t: "note", note: { id: "s-1", body: "existing" } });
  });
  test("a save answers the sender and pushes to every other watcher, and only them", () => {
    const { hub, client } = setup();
    const a = client(), b = client(), c = client();
    send(hub, a, { t: "note.watch", id: "s-1" });
    send(hub, b, { t: "note.watch", id: "s-1" });
    send(hub, c, { t: "note.watch", id: "s-2" }); // another note
    const [na, nb, nc] = [a.got.length, b.got.length, c.got.length];
    send(hub, a, { t: "note.save", id: "s-1", body: "from A", base: 0, req: 7 });
    expect(a.got.slice(na)).toEqual([{ t: "note.saved", req: 7, note: expect.objectContaining({ body: "from A" }) }]);
    expect(b.got.slice(nb)).toEqual([{ t: "note", note: expect.objectContaining({ body: "from A" }) }]);
    expect(c.got.length).toBe(nc); // does not watch s-1: hears nothing
  });
  test("a save from a stale version is a conflict carrying the newer note, and pushes nothing", () => {
    const { hub, client } = setup();
    const a = client(), b = client();
    send(hub, a, { t: "note.watch", id: "s-1" });
    send(hub, b, { t: "note.watch", id: "s-1" });
    send(hub, a, { t: "note.save", id: "s-1", body: "v1", base: 0, req: 1 });
    const v1 = a.got.at(-1).note.updatedAt;
    send(hub, b, { t: "note.save", id: "s-1", body: "B wins", base: v1, req: 1 });
    const na = a.got.length;
    send(hub, a, { t: "note.save", id: "s-1", body: "A stale", base: v1, req: 2 });
    expect(a.got.at(-1)).toEqual({ t: "note.conflict", req: 2, current: expect.objectContaining({ body: "B wins" }) });
    expect(a.got.length).toBe(na + 1);
  });
  test("bad input is answered with an error naming the request, never thrown", () => {
    const { hub, client } = setup(10);
    const a = client();
    hub.handle(a, "{nope");
    send(hub, a, { t: "note.watch", id: "../etc" });
    send(hub, a, { t: "note.save", id: "s-1", body: 42, req: 3 });
    send(hub, a, { t: "note.save", id: "s-1", body: "x".repeat(11), req: 4 });
    send(hub, a, { t: "note.save", id: "s-1", body: "ok" }); // no req
    send(hub, a, { t: "launch.missiles" });
    const errs = a.got.filter((m) => m.t === "error");
    expect(errs.map((e) => e.error)).toEqual(["not JSON", "invalid note id", "body must be a string", "a note can hold at most 10 characters", "a save needs a request number", "unknown message launch.missiles"]);
    expect(errs[2].req).toBe(3);
    expect(errs[3].req).toBe(4);
  });
  test("unwatch and leave stop the pushes; a gone client is forgotten", () => {
    const { hub, client } = setup();
    const a = client(), b = client();
    send(hub, a, { t: "note.watch", id: "s-1" });
    send(hub, b, { t: "note.watch", id: "s-1" });
    expect(hub.watchers("s-1")).toBe(2);
    send(hub, b, { t: "note.unwatch", id: "s-1" });
    hub.leave(a);
    expect(hub.watchers("s-1")).toBe(0);
    const nb = b.got.length;
    const c = client();
    send(hub, c, { t: "note.save", id: "s-1", body: "later", base: 0, req: 1 });
    expect(b.got.length).toBe(nb);
  });
  test("a change from outside the hub reaches the watchers", () => {
    const { hub, client, db } = setup();
    const a = client();
    send(hub, a, { t: "note.watch", id: "s-1" });
    const r = saveNote(db, "s-1", "from elsewhere");
    if (r.ok) hub.noteChanged(r.note);
    expect(a.got.at(-1)).toMatchObject({ t: "note", note: { body: "from elsewhere" } });
  });
  test("ping is answered", () => {
    const { hub, client } = setup();
    const a = client();
    send(hub, a, { t: "ping" });
    expect(a.got.at(-1)).toEqual({ t: "pong" });
  });
});
