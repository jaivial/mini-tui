/**
 * E47: the chat ↔ queue bridge resolved the wrong binary by default, and its deadline could not
 * kill. All three were measured against the deployed code before the fix (see log.md):
 *
 *  - `queueCommand(["graph-read"])` with no pinned binary ran the AGENT binary — a build without
 *    the `task-graph` cargo feature — which printed `error: unknown option: --db` and exited 2.
 *    That is exactly what `mini-tui queue …` did in production: the CLI passes no binary either.
 *    The bridge only worked because `consumerMain` passes MINITUI_QUEUE_BIN by hand.
 *  - a child that ignores SIGTERM (what the queue binary's handler effectively does) kept the
 *    promise pending past its own deadline: measured still pending at 15 s on a 1 s deadline.
 *  - the 4 MB cap broke the read loop and left the pipe unread, where a child blocked on write
 *    cannot exit: the await never returned either.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { queueCommand } from "../src/mini/queue";
import { resetQueueBinCache } from "../src/mini/queueBin";

let dir: string;
const saved: Record<string, string | undefined> = {};

function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Close the machine's world: HOME (where the installed fallbacks live) and both resolvers. Without
 * this, the assertions below are properties of whatever this box has installed. Each test gets its
 * own HOME, so one test's installed fakes cannot answer the next test's question.
 */
function closedWorld(name: string): string {
  for (const key of ["HOME", "MINITUI_QUEUE_BIN", "MINITUI_AGENT_BIN"]) saved[key] ??= process.env[key];
  const home = join(dir, name);
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  delete process.env.MINITUI_QUEUE_BIN;
  delete process.env.MINITUI_AGENT_BIN;
  resetQueueBinCache();
  return home;
}

function restoreWorld(): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetQueueBinCache();
}

describe("queueCommand", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "e47-queue-"));
  });

  afterAll(() => {
    restoreWorld();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the default resolver finds the installed queue build and never the agent binary", async () => {
    const home = closedWorld("home-finds-queue");
    // The deployed shape: the agent resolver returns a binary WITHOUT the queue feature, and the
    // queue build sits beside it under .local/lib/mini-tui (where A3/A3c/E46 deploy it).
    const lib = join(home, ".local", "lib", "mini-tui");
    mkdirSync(lib, { recursive: true });
    const agent = join(lib, "mini-agent-rs");
    writeFileSync(agent, '#!/bin/sh\necho "error: unknown option: --db" >&2\nexit 2\n');
    chmodSync(agent, 0o755);
    const queue = join(lib, "mini-agent-rs-taskgraph");
    writeFileSync(queue, '#!/bin/sh\nif [ "$1" = queue ] && [ "$2" = help ]; then exit 0; fi\nif [ "$1" = queue ] && [ "$2" = "graph-read" ]; then echo \'{"nodes":[]}\'; exit 0; fi\nexit 2\n');
    chmodSync(queue, 0o755);
    const result = await queueCommand(["graph-read"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output)).toEqual({ nodes: [] });
  });

  test("when no candidate answers queue, the failure names itself instead of a usage wall", async () => {
    const home = closedWorld("home-no-queue");
    const lib = join(home, ".local", "lib", "mini-tui");
    mkdirSync(lib, { recursive: true });
    const agent = join(lib, "mini-agent-rs");
    writeFileSync(agent, '#!/bin/sh\necho "error: unknown option: --db" >&2\nexit 2\n');
    chmodSync(agent, 0o755);
    await expect(queueCommand(["graph-read"])).rejects.toThrow(/no binary answers/);
  });

  test("an explicitly pinned binary is used as it is, never substituted behind the caller's back", async () => {
    const home = closedWorld("home-pinned");
    // A queue-capable build is present in the chain; the pin must still win, exactly as given.
    const lib = join(home, ".local", "lib", "mini-tui");
    mkdirSync(lib, { recursive: true });
    const queue = join(lib, "mini-agent-rs-taskgraph");
    writeFileSync(queue, '#!/bin/sh\necho "from-the-chain"\n');
    chmodSync(queue, 0o755);
    const pinned = script("pinned.sh", 'echo "from-the-pin"');
    const result = await queueCommand(["help"], undefined, { bin: pinned });
    expect(result.output).toContain("from-the-pin");
    expect(result.output).not.toContain("from-the-chain");
  });

  test("the child's own code, output and error come back unchanged", async () => {
    const bin = script("ok.sh", 'echo out\necho err >&2\nexit 3');
    const result = await queueCommand(["help"], undefined, { bin });
    expect(result.code).toBe(3);
    expect(result.output).toBe("out\n");
    expect(result.error).toBe("err\n");
  });

  test("a child that ignores SIGTERM is still gone at the deadline", async () => {
    // `trap '' TERM` is what the queue binary's handler effectively does: it sets a flag and
    // returns. Before E47 this promise was still pending 15 s after a 1 s deadline.
    const bin = script("stubborn.sh", 'trap "" TERM\nsleep 30\necho done');
    const t0 = Date.now();
    await expect(queueCommand(["help"], undefined, { bin, timeoutMs: 300 })).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test("the 4 MB cap names itself even when the child ignores SIGTERM and keeps writing", async () => {
    // Breaking the read loop used to leave the pipe unread: the child blocked on write, so the
    // await never returned and the cap was never reported.
    const bin = script("flood.sh", 'trap "" TERM\nwhile :; do head -c 1048576 /dev/zero | tr "\\0" "x"; done');
    const t0 = Date.now();
    await expect(queueCommand(["help"], undefined, { bin, timeoutMs: 30_000 })).rejects.toThrow(/exceeded 4MB/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test("abort ends the wait too, on a run that has no deadline of its own", async () => {
    const bin = script("stubborn-run.sh", 'trap "" TERM\nsleep 30');
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);
    const t0 = Date.now();
    const result = await queueCommand(["run"], abort.signal, { bin });
    expect(result.code).toBe(130);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test("queue.ts resolves through the capability chain, never through the agent resolver", () => {
    // E41's lesson: a guard that only covers one call site stops guarding the day the call moves.
    const source = readFileSync(join(import.meta.dir, "..", "src", "mini", "queue.ts"), "utf8");
    // Comments stripped: the doc names the resolver this replaced, and the guard is about code.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("rustAgentBin");
    expect(code).toContain("await queueBin()");
  });
});
