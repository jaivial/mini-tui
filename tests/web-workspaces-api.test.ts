/**
 * Manual chat mode on the server: saved workspaces over HTTP (shared with the terminal UI through
 * one file) and a mode switch that reaches every open tab.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "minitui-wsapi-"));
const PORT = 7900 + Math.floor(Math.random() * 100);
const base = `http://127.0.0.1:${PORT}`;
let proc: ReturnType<typeof Bun.spawn> | undefined;

beforeAll(async () => {
  proc = Bun.spawn({
    cmd: ["bun", "src/web/serve.ts", "--port", String(PORT)],
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"),
      MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"),
      MINITUI_SETTINGS_PATH: join(dir, "settings.json"),
      MINITUI_SKILLS_DIR: join(dir, "skills"),
      MINITUI_DB_PATH: join(dir, "sessions.db"),
      MINITUI_CONFIG_DIR: dir,
      // Set outright: another test file in the same run may have left its own path in process.env.
      MINITUI_WORKSPACES_PATH: join(dir, "workspaces.json"),
      MINITUI_RESUME_DIR: join(dir, "resume"),
      MINITUI_RUNS_DIR: join(dir, "runs"),
      MINITUI_WEB_TERMINAL: "0",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
});
afterAll(async () => {
  proc?.kill();
  await proc?.exited;
  rmSync(dir, { recursive: true, force: true });
});

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

test("workspaces: add, list, rename, remove, all in the shared file", async () => {
  expect(await (await send("GET", "/workspaces")).json()).toEqual({ workspaces: [] });
  const folder = join(dir, "api");
  mkdirSync(folder, { recursive: true });
  const created = await send("POST", "/workspaces", { path: folder, name: "API" });
  expect(created.status).toBe(201);
  const ws = (await created.json()) as { id: string; name: string; path: string };
  expect(ws).toMatchObject({ name: "API", path: folder });
  const file = JSON.parse(readFileSync(join(dir, "workspaces.json"), "utf8"));
  expect(file.workspaces.map((w: { id: string }) => w.id)).toEqual([ws.id]);

  const renamed = await send("PATCH", `/workspaces/${ws.id}`, { name: "Backend" });
  expect(((await renamed.json()) as { name: string }).name).toBe("Backend");

  expect((await send("DELETE", `/workspaces/${ws.id}`)).status).toBe(200);
  expect((await send("DELETE", `/workspaces/${ws.id}`)).status).toBe(404);
  expect(await (await send("GET", "/workspaces")).json()).toEqual({ workspaces: [] });
});

test("workspaces: a missing folder or an unknown host is the request's fault", async () => {
  const missing = await send("POST", "/workspaces", { path: join(dir, "nope") });
  expect(missing.status).toBe(400);
  expect(((await missing.json()) as { error: string }).error).toContain("is not a folder");
  expect((await send("POST", "/workspaces", { path: "~/x", hostId: "no-such-host" })).status).toBe(404);
});

test("workspaces: another site cannot add one", async () => {
  const r = await send("POST", "/workspaces", { path: dir }, { origin: "http://evil.example" });
  expect(r.status).toBe(403);
});

/** Opens the stream and waits past its snapshot frames, so later events are caused by the test. */
async function openStream() {
  const abort = new AbortController();
  const stream = await fetch(`${base}/api/stream`, { signal: abort.signal });
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (!buffered.includes('"type":"hosts"')) buffered += decoder.decode((await reader.read()).value, { stream: true });
  buffered = "";
  return {
    async settingsEvent(): Promise<{ settings?: { chatMode?: string } } | undefined> {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        buffered += decoder.decode((await reader.read()).value, { stream: true });
        for (const line of buffered.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const e = JSON.parse(line.slice(6));
          if (e.type === "settings") return e;
        }
      }
      return undefined;
    },
    close: () => abort.abort(),
  };
}

test("a chat mode switch is pushed to every open tab", async () => {
  const stream = await openStream();
  const patched = await send("PATCH", "/settings", { chatMode: "manual" });
  expect(((await patched.json()) as { chatMode: string }).chatMode).toBe("manual");
  const event = await stream.settingsEvent();
  stream.close();
  expect(event?.settings?.chatMode).toBe("manual");
  expect(((await (await send("GET", "/settings")).json()) as { chatMode: string }).chatMode).toBe("manual");
});

test("a switch the terminal UI saves to the shared file reaches open tabs too", async () => {
  const stream = await openStream();
  const file = join(dir, "settings.json");
  const stored = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, `${JSON.stringify({ ...stored, chatMode: "dispatcher" }, null, 2)}\n`);
  const event = await stream.settingsEvent();
  stream.close();
  expect(event?.settings?.chatMode).toBe("dispatcher");
});
