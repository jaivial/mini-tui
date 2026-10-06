/** The hub's task board topic, without a network: watch, push, who hears what, cleanup. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "minitui-hubtasks-"));
const savedResume = process.env.MINITUI_RESUME_DIR;
process.env.MINITUI_RESUME_DIR = join(dir, "resume");
afterAll(() => {
  if (savedResume === undefined) delete process.env.MINITUI_RESUME_DIR;
  else process.env.MINITUI_RESUME_DIR = savedResume;
  rmSync(dir, { recursive: true, force: true });
});
const { openDb, saveTask, listTasks, deleteTask, createSession } = await import("../src/sessions");
const { Hub } = await import("../src/web/hub");

function setup() {
  const db = openDb(join(dir, `${crypto.randomUUID()}.db`));
  createSession(db, { id: "s-1", cwd: "/tmp", model: "m", task: "t" });
  const hub = new Hub({ get: () => ({ id: "s-1", body: "", updatedAt: 0 }), save: () => ({ ok: true as const, note: { id: "s-1", body: "", updatedAt: 0 } }) }, 1000);
  hub.tasks = { list: () => listTasks(db) };
  const client = () => {
    const got: unknown[] = [];
    const c = { got, send: (m: unknown) => (got.push(m), true) };
    hub.join(c);
    return c;
  };
  return { hub, client, db };
}
const send = (hub: InstanceType<typeof Hub>, c: { send: (m: unknown) => boolean }, m: unknown) => hub.handle(c as never, JSON.stringify(m));

describe("the hub's task board", () => {
  test("watching is answered with the whole board at once", () => {
    const { hub, client, db } = setup();
    saveTask(db, "s-1", { title: "Fix login", description: "", todos: { done: [], pending: [], left: ["tests"] } });
    const a = client();
    send(hub, a, { t: "tasks.watch" });
    expect(a.got.at(-1)).toMatchObject({ t: "tasks", tasks: [{ id: "s-1", title: "Fix login" }] });
    db.close();
  });

  test("an agent writing a card pushes the board to every watcher", () => {
    const { hub, client, db } = setup();
    const a = client();
    const b = client();
    send(hub, a, { t: "tasks.watch" });
    send(hub, b, { t: "tasks.watch" });
    const na = a.got.length;
    const nb = b.got.length;
    saveTask(db, "s-1", { title: "written by the agent", description: "", todos: { done: [], pending: [], left: [] } });
    hub.tasksChanged();
    for (const c of [a, b]) expect(c.got.at(-1)).toMatchObject({ t: "tasks", tasks: [{ title: "written by the agent" }] });
    expect(a.got.length).toBe(na + 1);
    expect(b.got.length).toBe(nb + 1);
    db.close();
  });

  test("an unchanged board is not pushed again", () => {
    const { hub, client, db } = setup();
    const a = client();
    send(hub, a, { t: "tasks.watch" });
    const n = a.got.length;
    hub.tasksChanged(); // nothing was written since the watch
    hub.tasksChanged();
    expect(a.got.length).toBe(n);
    db.close();
  });

  test("a client that never watched hears nothing", () => {
    const { hub, client, db } = setup();
    const a = client();
    const bystander = client();
    send(hub, a, { t: "tasks.watch" });
    const n = bystander.got.length;
    saveTask(db, "s-1", { title: "x", description: "", todos: { done: [], pending: [], left: [] } });
    hub.tasksChanged();
    expect(bystander.got.length).toBe(n);
    db.close();
  });

  test("unwatching and leaving stop the pushes", () => {
    const { hub, client, db } = setup();
    const a = client();
    const b = client();
    send(hub, a, { t: "tasks.watch" });
    send(hub, b, { t: "tasks.watch" });
    send(hub, a, { t: "tasks.unwatch" });
    hub.leave(b as never);
    const na = a.got.length;
    const nb = b.got.length;
    saveTask(db, "s-1", { title: "x", description: "", todos: { done: [], pending: [], left: [] } });
    hub.tasksChanged();
    expect(a.got.length).toBe(na);
    expect(b.got.length).toBe(nb);
    expect(hub.taskWatchers).toBe(0);
    db.close();
  });

  test("a deleted card lands in the board as a push too", () => {
    const { hub, client, db } = setup();
    saveTask(db, "s-1", { title: "doomed", description: "", todos: { done: [], pending: [], left: [] } });
    const a = client();
    send(hub, a, { t: "tasks.watch" });
    deleteTask(db, "s-1");
    hub.tasksChanged();
    expect(a.got.at(-1)).toMatchObject({ t: "tasks", tasks: [] });
    db.close();
  });

  test("without a task source the watch is refused, never silent", () => {
    const db = openDb(join(dir, `${crypto.randomUUID()}.db`));
    const hub = new Hub({ get: () => ({ id: "s-1", body: "", updatedAt: 0 }), save: () => ({ ok: true as const, note: { id: "s-1", body: "", updatedAt: 0 } }) }, 1000);
    const got: unknown[] = [];
    const c = { send: (m: unknown) => (got.push(m), true) };
    hub.join(c);
    send(hub, c, { t: "tasks.watch" });
    expect(got.at(-1)).toMatchObject({ t: "error" });
    db.close();
  });
});
