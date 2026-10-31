import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { App } from "../src/ui/App";
import { createSession, openDb } from "../src/sessions";
import { addWorkspace, listWorkspaces, removeWorkspace } from "../src/workspaces";
import type { AttachmentRef, CreateSessionInput, FollowHandlers, QueueClientLike, QueueState, QueueSubscriber, QueueTaskView, RemoteHostView, SessionView } from "../src/queueClient";

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
  prompts: Array<{ text: string; model?: string; attachments?: string[] }> = [];
  redirects: Array<{ id: string; message: string }> = [];
  cancels: string[] = [];
  uploads: Array<{ name: string; size: number }> = [];
  creates: CreateSessionInput[] = [];
  sends: Array<{ id: string; prompt: string; attachments?: string[] }> = [];
  interrupts: string[] = [];
  models: Array<{ id: string; model: string }> = [];
  hostList: RemoteHostView[] = [];
  /** Uploads of files with this name are refused (the server's verdict). */
  refuse = "";
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
  prompt(text: string, model?: string, attachments?: AttachmentRef[]) {
    this.prompts.push({ text, model, ...(attachments ? { attachments: attachments.map((a) => a.id) } : {}) });
    return Promise.resolve({ id: this.st.main || "s-main" });
  }
  upload(file: { name: string; bytes: Uint8Array }) {
    if (file.name === this.refuse) return Promise.reject(new Error(`${file.name}: el archivo pasa de 15 MB`));
    this.uploads.push({ name: file.name, size: file.bytes.length });
    const id = String(this.uploads.length).padStart(16, "a");
    return Promise.resolve({ id, name: file.name, mime: "image/png", size: file.bytes.length, url: `/api/attachments/${id}` });
  }
  createSession(input: CreateSessionInput) {
    this.creates.push({ ...input, attachments: input.attachments });
    const id = `s-remote${this.creates.length}`;
    this.sessions[id] = { id, status: "running", model: input.model, cwd: input.cwd, events: [{ type: "task", text: input.prompt }, { type: "assistant", text: `REMOTE REPLY on ${input.hostId}` }] };
    return Promise.resolve({ id, status: "running" });
  }
  send(id: string, prompt: string, attachments?: AttachmentRef[]) {
    this.sends.push({ id, prompt, ...(attachments ? { attachments: attachments.map((a) => a.id) } : {}) });
    return Promise.resolve();
  }
  setModel(id: string, model: string) {
    this.models.push({ id, model });
    return Promise.resolve();
  }
  hosts() {
    return Promise.resolve(this.hostList);
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
  interrupt(id: string) {
    this.interrupts.push(id);
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

/** A folder with files to attach: two good ones, one of a refused type, one whose bytes lie. */
function attachFolder(): string {
  const dir = join(root, "att");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "screen shot.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]));
  writeFileSync(join(dir, "notes.md"), "# notes\n");
  writeFileSync(join(dir, "tool.exe"), "MZ");
  writeFileSync(join(dir, "fake.png"), "<html></html>");
  return dir;
}

async function sendText(setup: Setup, text: string) {
  await setup.mockInput.typeText(text);
  await act(async () => {
    setup.mockInput.pressEnter();
  });
  await settle(setup, 40);
}

describe("/attach", () => {
  test("dispatcher: Tab completes, bad files are refused, the files go up and their ids ride with the prompt", async () => {
    const dir = attachFolder();
    const fake = dispatcherFixture();
    const setup = await testRender(<App cwd={dir} persistSettings={false} queue={fake} initialModel="openai/gpt-mock" initialSettings={{ outputMode: "expanded" }} onQuit={() => {}} />, { width: 150, height: 34 });
    await settle(setup, 60);
    await setup.mockInput.typeText("/attach scr");
    await act(async () => {
      setup.mockInput.pressTab();
    });
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("/attach screen\\ shot.png");
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await settle(setup);
    let frame = setup.captureCharFrame();
    expect(frame).toContain("attached (1)");
    expect(frame).toContain("1. screen shot.png 10 B");

    await sendText(setup, "/attach notes.md tool.exe fake.png");
    frame = setup.captureCharFrame();
    expect(frame).toContain("attached (2)");
    expect(frame).toContain("2. notes.md");
    expect(frame).toContain("not attached: tool.exe: this type is not accepted");
    expect(frame).toContain("fake.png: the content is not a valid .png");

    await sendText(setup, "look at these");
    expect(fake.uploads).toEqual([{ name: "screen shot.png", size: 10 }, { name: "notes.md", size: 8 }]);
    expect(fake.prompts).toEqual([{ text: "look at these", model: "openai/gpt-mock", attachments: ["aaaaaaaaaaaaaaa1", "aaaaaaaaaaaaaaa2"] }]);
    expect(setup.captureCharFrame()).not.toContain("sent with the next prompt");

    // the server refuses one: nothing is sent, the prompt and the files stay
    fake.refuse = "notes.md";
    await sendText(setup, "/attach notes.md");
    await sendText(setup, "again");
    frame = setup.captureCharFrame();
    expect(fake.prompts).toHaveLength(1);
    expect(frame).toContain("attachments not sent: notes.md: el archivo pasa de 15 MB");
    expect(frame).toContain("attached (1)");
    expect(frame).toContain("again");
    for (let i = 0; i < "again".length; i++) await act(async () => setup.mockInput.pressBackspace()); // clear the restored prompt
    await settle(setup);
    await sendText(setup, "/detach");
    frame = setup.captureCharFrame();
    expect(frame).toContain("removed 1 attachment");
    expect(frame).not.toContain("sent with the next prompt");
    setup.renderer.destroy();
  });

  test("a local session names the files by path in the prompt (no server)", async () => {
    const dir = attachFolder();
    const sent: string[] = [];
    const setup = await testRender(
      <App cwd={dir} persistSettings={false} onSend={(text) => sent.push(text)} initialSettings={{ outputMode: "expanded", chatMode: "manual" }} onQuit={() => {}} />,
      { width: 150, height: 34 },
    );
    await settle(setup);
    await sendText(setup, "/attach notes.md");
    expect(setup.captureCharFrame()).toContain("attached (1)");
    await sendText(setup, "summarize");
    expect(sent).toEqual([`summarize\n\nAttached files (on this machine; read them from these paths):\n- ${join(dir, "notes.md")} (text/markdown, 8 B)`]);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Attached files");
    expect(frame).not.toContain("sent with the next prompt");
    // a prompt that merely starts with the word is a prompt
    await sendText(setup, "attach the logs to the report");
    expect(sent.at(-1)).toBe("attach the logs to the report");
    setup.renderer.destroy();
  });
});

describe("manual mode: a remote workspace", () => {
  test("runs through the server: created with its host, followed, continued, interrupted; a local pick returns", async () => {
    const alpha = join(root, "alpha");
    mkdirSync(alpha, { recursive: true });
    addWorkspace({ path: alpha, name: "Alpha" });
    const remote = addWorkspace({ path: "~/srv/app", name: "Remote App", hostId: "h-box" });
    const dir = attachFolder();
    const fake = dispatcherFixture();
    fake.hostList = [{ id: "h-box", label: "build box" }];
    const setup = await testRender(
      <App cwd={alpha} dbPath={join(root, "sessions.db")} persistSettings={false} queue={fake} initialModel="openai/gpt-mock" initialSettings={{ outputMode: "expanded", chatMode: "manual" }} onQuit={() => {}} />,
      { width: 150, height: 34 },
    );
    try {
      await settle(setup);
      await key(setup, "t", { ctrl: true });
      await settle(setup, 40);
      let frame = setup.captureCharFrame();
      expect(frame).toContain("Remote App");
      expect(frame).toContain("remote · on build box");
      const rows = listWorkspaces().length;
      for (let i = 0; i < rows; i++) {
        await act(async () => {
          setup.mockInput.pressArrow("down"); // remote rows come last
        });
      }
      await setup.renderOnce();
      await act(async () => {
        setup.mockInput.pressEnter();
      });
      await settle(setup, 40);
      frame = setup.captureCharFrame();
      expect(frame).toContain("◆ Remote App @ build box");
      expect(frame).toContain("build box:~/srv/app");
      expect(frame).toContain("sessions run on build box through the web server");
      expect(fake.followed).toEqual([]); // no session until the first prompt

      await sendText(setup, "deploy it");
      await settle(setup, 60);
      expect(fake.creates).toEqual([{ prompt: "deploy it", cwd: "~/srv/app", model: "openai/gpt-mock", target: "remote", hostId: "h-box", attachments: undefined }]);
      expect(fake.followed).toEqual(["s-remote1"]);
      expect(setup.captureCharFrame()).toContain("REMOTE REPLY on h-box");

      await sendText(setup, "and the docs");
      expect(fake.sends).toEqual([{ id: "s-remote1", prompt: "and the docs" }]);
      // files go up first, their ids ride with the follow-up
      await sendText(setup, `/attach ${join(dir, "notes.md")}`);
      await sendText(setup, "with the notes");
      expect(fake.uploads).toEqual([{ name: "notes.md", size: 8 }]);
      expect(fake.sends.at(-1)).toEqual({ id: "s-remote1", prompt: "with the notes", attachments: ["aaaaaaaaaaaaaaa1"] });

      // Esc Esc interrupts the remote turn
      setup.mockInput.pressEscape();
      await Bun.sleep(100);
      setup.mockInput.pressEscape();
      await Bun.sleep(100);
      await settle(setup);
      expect(fake.interrupts).toEqual(["s-remote1"]);

      await command(setup, "/model openai/gpt-other");
      await settle(setup);
      expect(fake.models).toEqual([{ id: "s-remote1", model: "openai/gpt-other" }]);

      await command(setup, "/new");
      await settle(setup);
      expect(setup.captureCharFrame()).toContain("new session on build box");
      expect(setup.captureCharFrame()).not.toContain("REMOTE REPLY");
      await sendText(setup, "second one");
      await settle(setup, 60);
      expect(fake.creates.at(-1)).toMatchObject({ prompt: "second one", hostId: "h-box", target: "remote" });
      expect(fake.followed.at(-1)).toBe("s-remote2");

      // back to a local workspace: local sessions again
      await key(setup, "t", { ctrl: true });
      for (let i = 0; i < rows; i++) {
        await act(async () => {
          setup.mockInput.pressArrow("up");
        });
      }
      await setup.renderOnce();
      await act(async () => {
        setup.mockInput.pressEnter();
      });
      await settle(setup, 40);
      frame = setup.captureCharFrame();
      expect(frame).toContain("◆ Alpha");
      expect(frame).not.toContain("@ build box");
      expect(frame).toContain("workspace Alpha");
    } finally {
      setup.renderer.destroy();
      removeWorkspace(remote.id);
    }
  });

  test("without a server client the remote row says why it cannot open", async () => {
    const remote = addWorkspace({ path: "~/srv/app", name: "Remote App", hostId: "h-box" });
    const setup = await testRender(
      <App cwd={root} dbPath={join(root, "sessions.db")} persistSettings={false} initialSettings={{ outputMode: "expanded", chatMode: "manual" }} onQuit={() => {}} />,
      { width: 150, height: 34 },
    );
    try {
      await settle(setup);
      await key(setup, "t", { ctrl: true });
      for (let i = 0; i < listWorkspaces().length; i++) {
        await act(async () => {
          setup.mockInput.pressArrow("down");
        });
      }
      await act(async () => {
        setup.mockInput.pressEnter();
      });
      await settle(setup);
      const frame = setup.captureCharFrame();
      expect(frame).toContain("remote · on h-box");
      expect(frame).toContain("does not reach here");
    } finally {
      setup.renderer.destroy();
      removeWorkspace(remote.id);
    }
  });
});
