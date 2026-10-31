import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { App } from "../src/ui/App";
import { createSession, openDb } from "../src/sessions";
import { addWorkspace, listWorkspaces } from "../src/workspaces";
import type { FollowHandlers, QueueClientLike, QueueState, QueueSubscriber, QueueTaskView, SessionView } from "../src/queueClient";

// bun runs every test file in one process: put the environment back for the files after this one
const ENV_KEYS = ["MINITUI_CONNECTIONS_PATH", "MINITUI_LAST_MODEL_PATH", "MINITUI_WORKSPACES_PATH"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
process.env.MINITUI_CONNECTIONS_PATH = "/dev/null/mini-tui-no-connections.json";
process.env.MINITUI_LAST_MODEL_PATH = "/dev/null/mini-tui-no-last-model.json";

const root = realpathSync(mkdtempSync(join(tmpdir(), "minitui-chatmode-")));
process.env.MINITUI_WORKSPACES_PATH = join(root, "workspaces.json");
afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(root, { recursive: true, force: true });
});

type Setup = Awaited<ReturnType<typeof testRender>>;

async function command(setup: Setup, text: string) {
  await setup.mockInput.typeText(text);
  await Bun.sleep(20);
  await act(async () => {
    setup.mockInput.pressEnter(); // the palette fills the prompt
  });
  await setup.renderOnce();
  await act(async () => {
    setup.mockInput.pressEnter(); // run it
  });
  await setup.renderOnce();
}

async function key(setup: Setup, k: string, modifiers?: { ctrl?: boolean; shift?: boolean }) {
  await act(async () => {
    setup.mockInput.pressKey(k, modifiers);
  });
  await Bun.sleep(5);
  await setup.renderOnce();
}

async function settle(setup: Setup, ms = 30) {
  await act(async () => {
    await Bun.sleep(ms);
  });
  await setup.renderOnce();
}

function task(id: string, status: QueueTaskView["status"], extra: Partial<QueueTaskView> = {}): QueueTaskView {
  return { id, seq: Number(id.slice(1)), title: `title of ${id}`, description: "", workspace: "billing", cwd: "/tmp", status, sessionId: "", result: "", createdAt: Date.now() - 60_000, startedAt: Date.now() - 30_000, finishedAt: 0, updatedAt: Date.now(), ...extra };
}

/** The queue client the App sees, without a server: records calls, serves canned sessions. */
class FakeQueue implements QueueClientLike {
  url = "http://127.0.0.1:7999";
  st: QueueState;
  subs = new Set<QueueSubscriber>();
  followed: string[] = [];
  handlers = new Map<string, FollowHandlers>();
  prompts: Array<{ text: string; model?: string }> = [];
  redirects: Array<{ id: string; message: string }> = [];
  cancels: string[] = [];
  newChats = 0;
  stopped = 0;
  constructor(state: QueueState, readonly sessions: Record<string, SessionView>) {
    this.st = state;
  }
  connect() {
    return Promise.resolve({ url: this.url, started: false });
  }
  state() {
    return this.st;
  }
  subscribe(sub: QueueSubscriber) {
    this.subs.add(sub);
    return () => void this.subs.delete(sub);
  }
  push(state: QueueState) {
    this.st = state;
    for (const sub of this.subs) sub.onQueue(state);
  }
  follow(id: string, handlers: FollowHandlers) {
    this.followed.push(id);
    this.handlers.set(id, handlers);
    const session = this.sessions[id];
    if (session) queueMicrotask(() => handlers.onSnapshot(session));
    return () => void this.handlers.delete(id);
  }
  prompt(text: string, model?: string) {
    this.prompts.push({ text, model });
    return Promise.resolve({ id: this.st.main || "s-main" });
  }
  newChat() {
    this.newChats++;
    this.push({ ...this.st, main: "" });
    return Promise.resolve();
  }
  cancel(id: string) {
    this.cancels.push(id);
    return Promise.resolve({ ok: true, text: `cancelled ${id}` });
  }
  redirect(id: string, message: string) {
    this.redirects.push({ id, message });
    return Promise.resolve({ ok: true, text: `redirected ${id}` });
  }
  interrupt() {
    return Promise.resolve();
  }
  compact() {
    return Promise.resolve();
  }
  stop() {
    this.stopped++;
  }
}

function dispatcherFixture() {
  return new FakeQueue(
    { tasks: [task("t1", "running", { sessionId: "s-w1", title: "fix the invoice export" }), task("t2", "queued", { title: "write the changelog", prompt: "write the changelog for 0.46" }), task("t3", "done", { sessionId: "s-w3", title: "bump deps", finishedAt: Date.now() - 5000 })], main: "s-main", concurrency: 4 },
    {
      "s-main": { id: "s-main", status: "idle", model: "openai/gpt-mock", events: [{ type: "task", text: "export invoices as csv\n\n<queue_state>\nINTERNAL STATE\n</queue_state>" }, { type: "task", text: '[queue] Task t9 "x" in workspace "w" finished with status done.' }, { type: "assistant", text: "Queued t1 for the export." }] },
      "s-w1": { id: "s-w1", status: "running", model: "openai/gpt-mock", events: [{ type: "task", text: "the worker brief" }, { type: "assistant", text: "WORKER IS ON IT" }] },
    },
  );
}

describe("settings: main chat mode", () => {
  test("Tab reaches the main chat group; ↓ switches to manual at once", async () => {
    const fake = dispatcherFixture();
    const setup = await testRender(<App cwd={root} persistSettings={false} queue={fake} initialSettings={{ outputMode: "expanded" }} onQuit={() => {}} />, { width: 120, height: 34 });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("main chat");
    await command(setup, "/settings");
    await act(async () => {
      setup.mockInput.pressTab();
    });
    await setup.renderOnce();
    await act(async () => {
      setup.mockInput.pressTab();
    });
    await setup.renderOnce();
    let frame = setup.captureCharFrame();
    expect(frame).toContain("main chat");
    expect(frame).toContain("dispatcher");
    expect(frame).toContain("manual");
    expect(frame).toContain("one main chat that creates and classifies tasks");
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await settle(setup);
    await act(async () => {
      setup.mockInput.pressEscape();
    });
    await settle(setup, 60);
    frame = setup.captureCharFrame();
    expect(frame).toContain("main chat: manual");
    expect(frame).not.toContain("Queued t1 for the export"); // the dispatcher transcript is gone
    // Tab twice more reaches jev, then back to the output group
    await command(setup, "/settings");
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        setup.mockInput.pressTab();
      });
      await setup.renderOnce();
    }
    expect(setup.captureCharFrame()).toContain("jev ·");
    setup.renderer.destroy();
  });
});

describe("dispatcher mode", () => {
  test("the main chat shows the server's session without queue plumbing; prompts go to the queue", async () => {
    const fake = dispatcherFixture();
    const setup = await testRender(<App cwd={root} persistSettings={false} queue={fake} initialModel="openai/gpt-mock" initialSettings={{ outputMode: "expanded" }} onQuit={() => {}} />, { width: 130, height: 34 });
    await settle(setup, 60);
    let frame = setup.captureCharFrame();
    expect(fake.followed).toEqual(["s-main"]);
    expect(frame).toContain("export invoices as csv");
    expect(frame).toContain("Queued t1 for the export.");
    expect(frame).not.toContain("INTERNAL STATE");
    expect(frame).not.toContain("[queue] Task");
    expect(frame).toContain("1 running · 1 queued"); // the status strip
    expect(frame).toContain("ask the dispatcher");

    await setup.mockInput.typeText("add a csv test");
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await settle(setup);
    expect(fake.prompts).toEqual([{ text: "add a csv test", model: "openai/gpt-mock" }]);

    // a delta from the server lands in the transcript, its status drives the chip
    await act(async () => {
      fake.handlers.get("s-main")!.onDelta([{ type: "task", text: "add a csv test\n<queue_state>x</queue_state>" }, { type: "assistant", text: "Queued t4." }], { id: "s-main", status: "done" });
    });
    await settle(setup);
    frame = setup.captureCharFrame();
    expect(frame).toContain("Queued t4.");
    expect(frame).not.toContain("<queue_state>");

    await command(setup, "/new");
    await settle(setup);
    expect(fake.newChats).toBe(1);
    frame = setup.captureCharFrame();
    expect(frame).not.toContain("Queued t1 for the export.");
    expect(frame).toContain("new main chat");
    setup.renderer.destroy();
  });

  test("/tasks: filter, open a worker (prompts redirect it), cancel with confirmation", async () => {
    const fake = dispatcherFixture();
    const setup = await testRender(<App cwd={root} persistSettings={false} queue={fake} initialSettings={{ outputMode: "expanded" }} onQuit={() => {}} />, { width: 130, height: 34 });
    await settle(setup, 60);
    await command(setup, "/tasks");
    let frame = setup.captureCharFrame();
    expect(frame).toContain("tasks · the work queue");
    expect(frame).toContain("fix the invoice export");
    expect(frame).toContain("write the changelog");
    expect(frame).toContain("bump deps");
    expect(frame).toContain("◆ billing");

    await key(setup, "f"); // → running
    frame = setup.captureCharFrame();
    expect(frame).toContain("[running 1]");
    expect(frame).not.toContain("write the changelog");
    await key(setup, "1"); // → all

    // c on the running task asks first; n keeps it
    await key(setup, "c");
    expect(setup.captureCharFrame()).toContain("cancel t1?");
    await key(setup, "n");
    expect(fake.cancels).toEqual([]);
    // the queued one: c, y
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await setup.renderOnce();
    await key(setup, "c");
    await key(setup, "y");
    await settle(setup);
    expect(fake.cancels).toEqual(["t2"]);
    expect(setup.captureCharFrame()).toContain("cancelled t2");

    // Enter on t1 opens its worker's session
    await act(async () => {
      setup.mockInput.pressArrow("up");
    });
    await setup.renderOnce();
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await settle(setup, 60);
    frame = setup.captureCharFrame();
    expect(fake.followed.at(-1)).toBe("s-w1");
    expect(frame).toContain("WORKER IS ON IT");
    expect(frame).toContain("task t1");
    expect(frame).toContain("redirect t1");

    await setup.mockInput.typeText("use semicolons");
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await settle(setup);
    expect(fake.redirects).toEqual([{ id: "t1", message: "use semicolons" }]);
    expect(fake.prompts).toEqual([]);
    expect(setup.captureCharFrame()).toContain("redirected t1");

    await command(setup, "/main");
    await settle(setup, 60);
    frame = setup.captureCharFrame();
    expect(fake.followed.at(-1)).toBe("s-main");
    expect(frame).toContain("Queued t1 for the export.");
    expect(frame).not.toContain("WORKER IS ON IT");
    setup.renderer.destroy();
  });

  test("ctrl+t opens the task list; a queued task without a session shows its brief", async () => {
    const fake = dispatcherFixture();
    const setup = await testRender(<App cwd={root} persistSettings={false} queue={fake} initialSettings={{ outputMode: "expanded" }} onQuit={() => {}} />, { width: 130, height: 34 });
    await settle(setup, 60);
    await key(setup, "t", { ctrl: true });
    expect(setup.captureCharFrame()).toContain("tasks · the work queue");
    await key(setup, "2"); // running
    await key(setup, "3"); // queued
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await settle(setup, 40);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("write the changelog for 0.46");
    expect(frame).toContain("no worker session yet");
    setup.renderer.destroy();
  });
});

describe("manual mode: workspaces", () => {
  test("list, switch, add (Tab completes), rename and remove", async () => {
    const alpha = join(root, "alpha");
    const beta = join(root, "beta");
    const gamma = join(root, "gamma");
    for (const dir of [alpha, beta, gamma]) mkdirSync(dir, { recursive: true });
    addWorkspace({ path: alpha, name: "Alpha" });
    addWorkspace({ path: beta, name: "Beta" });
    const dbPath = join(root, "sessions.db");
    const db = openDb(dbPath);
    createSession(db, { id: "s-b1", cwd: beta, model: "m", task: "one" });
    createSession(db, { id: "s-b2", cwd: beta, model: "m", task: "two" });
    db.close();

    const fake = dispatcherFixture();
    const setup = await testRender(
      <App cwd={alpha} dbPath={dbPath} persistSettings={false} queue={fake} initialSettings={{ outputMode: "expanded", chatMode: "manual" }} onQuit={() => {}} />,
      { width: 130, height: 34 },
    );
    await settle(setup);
    let frame = setup.captureCharFrame();
    expect(fake.followed).toEqual([]); // manual: no dispatcher
    expect(frame).toContain("◆ Alpha"); // the launch folder is a saved workspace

    await command(setup, "/workspaces");
    frame = setup.captureCharFrame();
    expect(frame).toContain("workspaces · new sessions start");
    expect(frame).toContain("Beta");
    expect(frame).toContain("2 sessions");
    expect(frame).toContain("● current");

    // Enter on Beta switches there
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await setup.renderOnce();
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await settle(setup);
    frame = setup.captureCharFrame();
    expect(frame).toContain("◆ Beta");
    expect(frame).toContain("workspace Beta");

    // add gamma: n, type the folder, Enter, a name, Enter
    await key(setup, "t", { ctrl: true });
    await key(setup, "n");
    for (let i = 0; i < 2; i++) await act(async () => setup.mockInput.pressBackspace());
    await setup.mockInput.typeText(join(root, "gam"));
    await act(async () => {
      setup.mockInput.pressTab(); // completes the folder
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain(`${gamma}/`);
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    await setup.mockInput.typeText("Gamma ws");
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("added Gamma ws");
    expect(listWorkspaces().map((w) => w.name)).toEqual(["Alpha", "Beta", "Gamma ws"]);

    // r renames the selected one (Gamma ws)
    await key(setup, "r");
    for (let i = 0; i < 3; i++) await act(async () => setup.mockInput.pressBackspace());
    await setup.mockInput.typeText("!");
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    expect(listWorkspaces().map((w) => w.name)).toContain("Gamma!");

    // d asks, y removes
    await key(setup, "d");
    expect(setup.captureCharFrame()).toContain("remove Gamma!?");
    await key(setup, "y");
    expect(listWorkspaces().map((w) => w.name)).toEqual(["Alpha", "Beta"]);

    // a folder that does not exist is refused before the name step
    await key(setup, "n");
    await setup.mockInput.typeText("does-not-exist-here");
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("is not a folder on this machine");
    setup.renderer.destroy();
  });

  test("s saves the current folder as a workspace and labels the status line", async () => {
    const delta = join(root, "delta");
    mkdirSync(delta, { recursive: true });
    const setup = await testRender(<App cwd={delta} dbPath={join(root, "sessions.db")} persistSettings={false} initialSettings={{ outputMode: "expanded", chatMode: "manual" }} onQuit={() => {}} />, { width: 130, height: 34 });
    await settle(setup);
    expect(setup.captureCharFrame()).not.toContain("◆ delta");
    await key(setup, "t", { ctrl: true });
    await key(setup, "s");
    expect(setup.captureCharFrame()).toContain("saved delta");
    await act(async () => {
      setup.mockInput.pressEscape();
    });
    await settle(setup, 60);
    expect(setup.captureCharFrame()).toContain("◆ delta");
    expect(listWorkspaces().some((w) => w.path === delta)).toBe(true);
    setup.renderer.destroy();
  });

  test("/tasks in manual mode says where it belongs", async () => {
    const fake = dispatcherFixture();
    const setup = await testRender(<App cwd={root} persistSettings={false} queue={fake} initialSettings={{ outputMode: "expanded", chatMode: "manual" }} onQuit={() => {}} />, { width: 130, height: 34 });
    await settle(setup);
    await command(setup, "/tasks");
    expect(setup.captureCharFrame()).toContain("the task list belongs to the dispatcher chat mode");
    setup.renderer.destroy();
  });
});
