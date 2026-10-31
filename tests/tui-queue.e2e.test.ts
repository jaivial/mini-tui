/**
 * The terminal's queue client against the real web server: the server is started the way the TUI
 * starts it when none runs (a child on a loopback port, stopped with the client), the model is the
 * scripted mock (benchmark/stress/mock_llm.py: "CREATE 1" makes the dispatcher create one task).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QueueClient, cleanQueueEvents, type QueueState, type SessionView } from "../src/queueClient";
import type { RunEvent } from "../src/traj/schema";

const repo = join(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "minitui-tui-queue-"));
const base = 7900 + Math.floor(Math.random() * 90);
const MOCK_PORT = base;
const SERVER_PORT = base + 5;
let mock: ReturnType<typeof Bun.spawn> | undefined;
let client: QueueClient | undefined;

// other test files in this process point MINITUI_* / MSWEA_* at their own stubs: start clean
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MINITUI_|MINI_|MSWEA_)/.test(key))) as Record<string, string>;
const env: Record<string, string> = {
  ...inherited,
  MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"),
  MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"),
  MINITUI_SETTINGS_PATH: join(dir, "settings.json"),
  MINITUI_SKILLS_DIR: join(dir, "skills"),
  MINITUI_DB_PATH: join(dir, "sessions.db"),
  MINITUI_CONFIG_DIR: dir,
  MINITUI_RESUME_DIR: join(dir, "resume"),
  MINITUI_RUNS_DIR: join(dir, "runs"),
  MINITUI_WEB_TERMINAL: "0",
  MINITUI_TASK_GRAPH_DB: join(dir, "task-graph.sqlite"),
  MSWEA_OPENAI_API_BASE: `http://127.0.0.1:${MOCK_PORT}/v1`,
  MSWEA_OPENAI_API_KEY: "mock",
  MINITUI_MODEL: "openai/gpt-mock",
};

async function until<T>(read: () => T | undefined | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  mock = Bun.spawn(["python3", join(repo, "benchmark/stress/mock_llm.py"), String(MOCK_PORT), "0.02"], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${MOCK_PORT}/stats`);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error("mock model did not start");
});

afterAll(async () => {
  client?.stop();
  mock?.kill();
  await mock?.exited;
  await Bun.sleep(300); // the server's SIGTERM handler saves and exits
  rmSync(dir, { recursive: true, force: true });
});

test("the TUI client starts a server, lists the queue, and a prompt creates the main chat and a task", async () => {
  const nobody = `http://127.0.0.1:${SERVER_PORT + 1}`;
  client = new QueueClient({ url: nobody, autoStart: true, env, logDir: join(dir, "runs"), serverPort: SERVER_PORT, startTimeoutMs: 30_000 });
  const connected = await client.connect();
  expect(connected.started).toBe(true);
  expect(connected.url).toBe(`http://127.0.0.1:${SERVER_PORT}`);
  expect(existsSync(connected.logPath!)).toBe(true);

  const first = await client.list();
  expect(first.tasks).toEqual([]);
  expect(first.main).toBe("");

  let state: QueueState = first;
  let live = false;
  client.subscribe({ onQueue: (next) => (state = next), onLink: (up) => (live = up) });
  await until(() => live, 5000, "the SSE stream");

  const { id } = await client.prompt("CREATE 1", "openai/gpt-mock");
  expect(id).toMatch(/\w/);
  expect(client.state().main).toBe(id);

  // the main chat's transcript over its socket: the message as typed, no <queue_state>
  let events: RunEvent[] = [];
  let session: SessionView | undefined;
  const stop = client.follow(id, {
    onSnapshot: (s) => {
      session = s;
      events = s.events;
    },
    onDelta: (fresh) => {
      events = [...events, ...fresh];
    },
  });
  try {
    await until(() => session, 10_000, "the main chat's snapshot");
    const created = await until(() => state.tasks.length >= 1 && state.tasks[0], 60_000, "the dispatcher's task (the queue's SSE delta)");
    expect(state.main).toBe(id);
    expect(created.title.length).toBeGreaterThan(0);
    const shown = cleanQueueEvents(events);
    const typed = shown.find((e) => e.type === "task");
    expect(typed && typed.type === "task" ? typed.text : "").toBe("CREATE 1");
    expect(shown.some((e) => e.type === "task" && e.text.includes("<queue_state>"))).toBe(false);
    // the worker runs on the mock model and the task settles
    const settled = await until(() => state.tasks.find((t) => t.id === created.id && (t.status === "done" || t.status === "error")), 90_000, "the task to finish");
    expect(settled.status).toBe("done");
    expect(settled.sessionId).toMatch(/\w/);
  } finally {
    stop();
  }
}, 180_000);
