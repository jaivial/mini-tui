/**
 * A follow-up prompt on a REMOTE session must not start a second agent beside the live one.
 *
 * A remote turn is a one-shot `ssh` with no control channel, and `SessionManager.send` decided
 * whether a session was busy with `!!entry.run && !entry.exited` — a field a remote turn NEVER
 * sets (it keeps its handle in `entry.remote`). So every remote session looked idle to itself: a
 * second prompt took the "start a fresh turn" branch, spawned a second `ssh`, and overwrote
 * `entry.remote`, which is the only handle `interrupt()`/`close()` had. Measured against the
 * deployed build: two agents on one conversation, `interrupt` killing only the newer one, and
 * the older one still spending the host's tokens with nobody holding it.
 *
 * These tests drive the real `SessionManager` against a fake `ssh` on PATH, so the wiring under
 * test is the deployed one: `send` -> `#continueRemote` -> `startRemoteRun` -> `Bun.spawn`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "minitui-remote-parallel-"));
process.env.MINITUI_DB_PATH = join(dir, "sessions.db");
process.env.MINITUI_RESUME_DIR = join(dir, "resume");
process.env.MINITUI_RUNS_DIR = join(dir, "runs");
process.env.MINITUI_SETTINGS_PATH = join(dir, "settings.json");
process.env.MINITUI_CONFIG_DIR = dir;
process.env.MINITUI_LAST_MODEL_PATH = join(dir, "last-model.json");
process.env.MINITUI_CONNECTIONS_PATH = join(dir, "providers.json");
process.env.MINITUI_MINI_BIN = join(dir, "mini-stub");
writeFileSync(process.env.MINITUI_MINI_BIN, "#!/bin/sh\nexit 0\n");
chmodSync(process.env.MINITUI_MINI_BIN, 0o755);
process.env.MINITUI_EMBEDDED_AGENT = "0";

// The fake `ssh` is what makes these tests about the SERVER's wiring rather than about a mocked
// transport: `startRemoteRun` really spawns it, really feeds it the remote script on stdin, and
// really reads its stream-json back. Each run announces itself in the log named by `$QA_SSH_LOG`
// and then stays alive for `$QA_HOLD_MS`, so a test can send a prompt into a live turn and see
// whether a second process appears. The log is per test on purpose: a shared file races a stub
// that is still dying when the next test truncates it, and one leaked line silently moves a
// later test's process count.
//
// The stub is a real file rather than an inline string because it needs shell quoting of its own,
// and a JS template literal full of escaped quotes is unreadable.
const sshDir = join(dir, "bin");
mkdirSync(sshDir, { recursive: true });
const sshBin = join(sshDir, "ssh");
copyFileSync(join(import.meta.dir, "fixtures", "fake-ssh"), sshBin);
chmodSync(sshBin, 0o755);

beforeAll(() => {
  // NOT at module scope: bun's test runner rebuilds `process.env` for the test process, so a PATH
  // set while this file is being evaluated is gone by the time a test spawns anything. Set it
  // here and the stub is the `ssh` every run in this file reaches.
  process.env.PATH = `${sshDir}:${process.env.PATH ?? ""}`;
});

const { saveHosts, SessionManager: SM } = await import("../src/web/sessions");

const HOST = {
  id: "h-remote",
  label: "stub box",
  host: "192.0.2.1",
  port: 22,
  user: "u",
  workdir: "/remote",
  identity: join(dir, "id_fake"),
};
writeFileSync(HOST.identity, "fake\n");
chmodSync(HOST.identity, 0o600);
saveHosts([HOST]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let logSeq = 0;
const newLog = (): string => join(dir, `ssh-${logSeq++}.log`);
process.env.QA_SSH_LOG = newLog();
const runs = (): string[] => {
  try {
    return readFileSync(process.env.QA_SSH_LOG!, "utf8")
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
};
const started = (): number => runs().filter((l) => l.endsWith("START")).length;

const managers: InstanceType<typeof SM>[] = [];
function manager(): InstanceType<typeof SM> {
  const m = new SM(() => {});
  managers.push(m);
  return m;
}

/**
 * Wait until the session has published `n` exit cards. Waiting on the transcript rather than on
 * the transport is deliberate: a queued turn starts *after* the run before it has ended, so the
 * process log reaches n before that turn has said anything.
 */
async function waitForExitsIn(m: InstanceType<typeof SM>, id: string, n: number, budget = 10_000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const exits = m.get(id)?.events.filter((e) => e.type === "exit").length ?? 0;
    if (exits >= n) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${n} exit cards; events:\n${JSON.stringify(m.get(id)?.events)}`);
}

/** Wait for `n` ssh runs to have finished, so a test never races the transport. */
async function waitForExits(n: number, budget = 8000): Promise<void> {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (runs().filter((l) => l.endsWith("EXIT") || l.endsWith("STOP")).length >= n) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${n} ssh runs to end; log:\n${runs().join("\n")}`);
}

afterEach(async () => {
  for (const m of managers.splice(0)) {
    for (const s of m.list()) m.close(s.id);
  }
  // Wait for every stub this test started to be gone before the next one gets a fresh log, so a
  // process that outlives its test cannot append to another test's count.
  const startedHere = started();
  const deadline = Date.now() + 4000;
  while (startedHere && Date.now() < deadline) {
    const ended = runs().filter((l) => l.endsWith("EXIT") || l.endsWith("STOP")).length;
    if (ended >= startedHere) break;
    await sleep(25);
  }
  process.env.QA_SSH_LOG = newLog();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a remote session runs one turn at a time", () => {
  test("a prompt sent while a remote turn is live queues instead of spawning a second agent", async () => {
    process.env.QA_HOLD_MS = "900";
    const m = manager();
    const s = await m.create({ prompt: "first", target: "remote", hostId: HOST.id });
    await sleep(250); // the first ssh is up and streaming

    await m.send(s.id, "second, while the first is still running");
    // The whole point: no second process. Before the fix this was 2, running side by side.
    expect(started()).toBe(1);

    await waitForExits(1);
    // The queued prompt runs after, as its own turn: nothing the user typed is dropped.
    await waitForExitsIn(m, s.id, 2);
    expect(started()).toBe(2);

    const after = m.get(s.id)!;
    const tasks = after.events.filter((e) => e.type === "task");
    expect(tasks).toHaveLength(2);
    expect(after.status).toBe("done");
  }, 20_000);

  test("the queue is visible in the transcript, not a silent wait", async () => {
    process.env.QA_HOLD_MS = "900";
    const m = manager();
    const s = await m.create({ prompt: "first", target: "remote", hostId: HOST.id });
    await sleep(250);
    await m.send(s.id, "second");
    // `send` does not await `#continueRemote` (it must not block the request), so the notice
    // lands on the next turn of the loop.
    await sleep(120);
    const notice = m.get(s.id)!.events.find((e) => e.type === "notice" && /queued/.test(e.text));
    expect(notice).toBeDefined();
    await waitForExitsIn(m, s.id, 2);
  }, 20_000);
});

describe("every remote turn ends visibly", () => {
  test("each turn gets its own exit card, not just the first", async () => {
    process.env.QA_HOLD_MS = "200";
    const m = manager();
    const s = await m.create({ prompt: "one", target: "remote", hostId: HOST.id });
    await waitForExitsIn(m, s.id, 1);
    await m.send(s.id, "two");
    await waitForExitsIn(m, s.id, 2);

    const exits = m.get(s.id)!.events.filter((e) => e.type === "exit");
    // The guard used to be session-wide (`!session.events.some(exit)`), so a follow-up turn
    // finished in silence: one exit card for a two-turn conversation.
    expect(exits).toHaveLength(2);
    expect(exits.every((e) => (e as { exitStatus: string }).exitStatus === "Submitted")).toBe(true);
  }, 20_000);

  test("a turn's cost and api calls are added, not frozen at the first turn", async () => {
    process.env.QA_HOLD_MS = "200";
    const m = manager();
    const s = await m.create({ prompt: "one", target: "remote", hostId: HOST.id });
    await waitForExitsIn(m, s.id, 1);
    expect(m.get(s.id)!.cost).toBeCloseTo(0.002, 6);

    await m.send(s.id, "two");
    await waitForExitsIn(m, s.id, 2);
    const after = m.get(s.id)!;
    // `#consumeRemote` never read `cost_usd`/`api_calls` at all, so a follow-up turn's spend was
    // invisible on the session and in the persisted row.
    expect(after.cost).toBeCloseTo(0.004, 6);
    expect(after.apiCalls).toBe(2);
  }, 20_000);
});

describe("nothing survives the session", () => {
  // Both of these send a second prompt INTO the live turn first. Without that they would pass
  // against `origin/main` for the wrong reason: main only ever had one run to stop, so
  // `entry.remote?.stop()` looked sufficient. The orphan was the run it had already forgotten.
  test("interrupt stops the live remote turn even after a prompt was queued behind it", async () => {
    process.env.QA_HOLD_MS = "5000";
    const m = manager();
    const s = await m.create({ prompt: "long", target: "remote", hostId: HOST.id });
    await sleep(250);
    await m.send(s.id, "queued behind the turn about to be stopped");
    await sleep(120);
    expect(started()).toBe(1);

    m.interrupt(s.id);
    await waitForExits(1);
    expect(m.get(s.id)!.status).toBe("interrupted");
    expect(runs().filter((l) => l.endsWith("STOP")).length).toBe(1);
    await sleep(400);
    // Nothing may be left running on the host, and nothing queued may start afterwards.
    expect(started()).toBe(1);
    expect(runs().filter((l) => l.endsWith("STOP") || l.endsWith("EXIT"))).toHaveLength(1);
  }, 20_000);

  test("closing a remote session leaves no agent running on the host", async () => {
    process.env.QA_HOLD_MS = "5000";
    const m = manager();
    const s = await m.create({ prompt: "long", target: "remote", hostId: HOST.id });
    await sleep(250);
    await m.send(s.id, "queued behind the turn that is about to be closed");
    await sleep(120);
    expect(started()).toBe(1);

    m.close(s.id);
    await waitForExits(1);
    expect(runs().filter((l) => l.endsWith("STOP")).length).toBe(1);
    await sleep(400);
    expect(started()).toBe(1);
    expect(runs().filter((l) => l.endsWith("STOP") || l.endsWith("EXIT"))).toHaveLength(1);
  }, 20_000);

  test("interrupt with a prompt queued drops the queue instead of running it later", async () => {
    process.env.QA_HOLD_MS = "900";
    const m = manager();
    const s = await m.create({ prompt: "first", target: "remote", hostId: HOST.id });
    await sleep(250);
    await m.send(s.id, "queued behind the interrupt");

    m.interrupt(s.id);
    await waitForExits(1);
    await sleep(700);
    // After stopping, nothing may start: the user said stop, not "stop and then do the next thing".
    // Both assertions matter: on main the second prompt had already become a SECOND run, so this
    // passed there for the wrong reason while the real turn it displaced kept going.
    expect(started()).toBe(1);
    expect(runs().filter((l) => l.endsWith("STOP") || l.endsWith("EXIT"))).toHaveLength(1);
  }, 20_000);

  test("the queued prompt is not silently dropped either: it runs after the live turn ends", async () => {
    process.env.QA_HOLD_MS = "400";
    const m = manager();
    const s = await m.create({ prompt: "first", target: "remote", hostId: HOST.id });
    await sleep(150);
    await m.send(s.id, "second");
    await waitForExitsIn(m, s.id, 2);
    // The whole point of queueing instead of forking: the second prompt is not thrown away.
    expect(started()).toBe(2);
    const tasks = m.get(s.id)!.events.filter((e) => e.type === "task");
    expect(tasks).toHaveLength(2);
  }, 20_000);
});
