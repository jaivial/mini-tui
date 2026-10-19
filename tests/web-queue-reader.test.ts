/**
 * The queue reader behind `/task-graph` and `/task-events` (E46).
 *
 * Two measured defects, both in the same code path:
 *  - the reader resolved the AGENT binary, which is free to be a build without the `task-graph`
 *    feature, so production answered 503 for the whole deployment;
 *  - its deadline was `child.kill()`, i.e. SIGTERM, and the queue binary's SIGTERM handler only
 *    sets a flag, so the deadline never fired.
 *
 * These tests use real child processes (a shell script standing in for the binary), because the
 * defect IS the process interaction: a fake timer cannot tell a SIGTERM from a SIGKILL.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { queueBin, resetQueueBinCache } from "../src/mini/queueBin";
import { QUEUE_READ_MAX_BYTES, runQueueRead } from "../src/mini/queueRead";

let dir: string;

/** A stand-in queue binary whose behaviour the test picks by name. */
function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "e46-queue-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("queueBin", () => {
  test("a binary without the queue subcommand is not a queue binary", async () => {
    resetQueueBinCache();
    const agent = script("agent-only.sh", 'echo "error: unknown option: --db" >&2\nexit 2');
    // HOME closes the world (E47): without it, the chain falls through to whatever THIS machine
    // has installed and the assertion becomes a property of the box, not of the resolver.
    expect(await queueBin({ MINITUI_QUEUE_BIN: agent, MINITUI_AGENT_BIN: agent, HOME: dir })).toBeUndefined();
  });

  test("a binary that answers queue help is accepted", async () => {
    resetQueueBinCache();
    const bin = script("queue-ok.sh", 'if [ "$1" = queue ] && [ "$2" = help ]; then echo "{}"; exit 0; fi\nexit 2');
    expect(await queueBin({ MINITUI_QUEUE_BIN: bin })).toBe(bin);
  });

  test("the declared queue binary wins over the agent binary", async () => {
    resetQueueBinCache();
    const queue = script("declared.sh", 'if [ "$1" = queue ] && [ "$2" = help ]; then exit 0; fi\nexit 2');
    const agent = script("agent-chain.sh", 'exit 2');
    expect(await queueBin({ MINITUI_QUEUE_BIN: queue, MINITUI_AGENT_BIN: agent })).toBe(queue);
  });

  test("the chain reaches the installed queue build that sits beside the agent binary", async () => {
    // E47: `mini-agent-rs-taskgraph` is where the queue build is deployed (A3/A3c/E46). If the
    // chain cannot reach it, finding a queue binary depends on MINITUI_QUEUE_BIN being set — the
    // habit E47 removed.
    resetQueueBinCache();
    const home = join(dir, "home-installed");
    const lib = join(home, ".local", "lib", "mini-tui");
    mkdirSync(lib, { recursive: true });
    const agent = join(lib, "mini-agent-rs");
    writeFileSync(agent, '#!/bin/sh\necho "error: unknown option: --db" >&2\nexit 2\n');
    chmodSync(agent, 0o755);
    const queue = join(lib, "mini-agent-rs-taskgraph");
    writeFileSync(queue, '#!/bin/sh\nif [ "$1" = queue ] && [ "$2" = help ]; then exit 0; fi\necho "{}"\n');
    chmodSync(queue, 0o755);
    expect(await queueBin({ HOME: home, MINITUI_AGENT_BIN: agent })).toBe(queue);
  });

  test("the verdict is cached, so a failing binary is probed once and not once per request", async () => {
    resetQueueBinCache();
    const bin = script("counted.sh", 'if [ "$1" = queue ] && [ "$2" = help ]; then echo x >> "$COUNT_FILE"; exit 0; fi\nexit 2');
    const countFile = join(dir, "probe-count");
    const env = { MINITUI_QUEUE_BIN: bin, COUNT_FILE: countFile };
    expect(await queueBin(env)).toBe(bin);
    await queueBin(env);
    await queueBin(env);
    expect(readFileSync(countFile, "utf8").trim().split("\n").filter(Boolean).length).toBe(1);
  });
});

describe("runQueueRead", () => {
  test("returns the parsed JSON of a read that finishes", async () => {
    const bin = script("read-ok.sh", 'echo \'{"events":[],"cursor":7}\'');
    const read = await runQueueRead(["queue", "events-read"], { env: { MINITUI_QUEUE_BIN: bin } });
    expect(read.reason).toBeUndefined();
    expect(read.value).toEqual({ events: [], cursor: 7 });
  });

  test("a read that ignores SIGTERM is still killed at the deadline", async () => {
    // `trap '' TERM` is exactly what the real queue binary does: its handler sets a flag and
    // returns. With a plain child.kill() this child runs forever and the await never resolves.
    const marker = join(dir, "still-running");
    const bin = script("stubborn.sh", 'if [ "$1" = queue ] && [ "$2" = help ]; then exit 0; fi\ntrap "" TERM\nsleep 30\necho done > "' + marker + '"\necho "{}"');
    const t0 = Date.now();
    const read = await runQueueRead(["queue", "graph-read"], { env: { MINITUI_QUEUE_BIN: bin }, timeoutMs: 300 });
    const elapsed = Date.now() - t0;
    expect(read.reason).toBe("timeout");
    expect(elapsed).toBeLessThan(5_000);
    expect(read.value).toBeUndefined();
  });

  test("the deadline names itself instead of reporting a generic failure", async () => {
    const bin = script("slow.sh", 'if [ "$1" = queue ] && [ "$2" = help ]; then exit 0; fi\nsleep 30');
    const read = await runQueueRead(["queue", "graph-read"], { env: { MINITUI_QUEUE_BIN: bin }, timeoutMs: 200 });
    expect(read.reason).toBe("timeout");
  });

  test("a non-zero exit is reported as an exit, with the binary's own words", async () => {
    const bin = script("fails.sh", 'if [ "$1" = queue ] && [ "$2" = help ]; then exit 0; fi\necho "error: database is locked" >&2\nexit 3');
    const read = await runQueueRead(["queue", "graph-read"], { env: { MINITUI_QUEUE_BIN: bin } });
    expect(read.reason).toBe("exit");
    expect(read.exit).toBe(3);
    expect(read.stderr).toContain("database is locked");
  });

  test("output past the cap is refused instead of buffered whole", async () => {
    // The old reader awaited `new Response(child.stdout).text()` with no ceiling at all.
    const bin = script("flood.sh", 'if [ "$1" = queue ] && [ "$2" = help ]; then exit 0; fi\ni=0\nwhile [ $i -lt 4000 ]; do head -c 1024 /dev/zero | tr "\\0" "x"; echo; i=$((i+1)); done');
    const read = await runQueueRead(["queue", "graph-read"], { env: { MINITUI_QUEUE_BIN: bin }, maxBytes: 64 * 1024, timeoutMs: 20_000 });
    expect(read.reason).toBe("too-large");
    expect(read.value).toBeUndefined();
  });

  test("output that is not JSON is named, not thrown", async () => {
    const bin = script("not-json.sh", 'if [ "$1" = queue ] && [ "$2" = help ]; then exit 0; fi\necho "usage: mini-swe-agent-tui"');
    const read = await runQueueRead(["queue", "graph-read"], { env: { MINITUI_QUEUE_BIN: bin } });
    expect(read.reason).toBe("bad-json");
  });

  test("no binary at all is its own reason", async () => {
    resetQueueBinCache();
    const missing = join(dir, "not-there");
    const read = await runQueueRead(["queue", "graph-read"], { env: { MINITUI_QUEUE_BIN: missing, MINITUI_AGENT_BIN: missing, HOME: dir } });
    expect(read.reason).toBe("no-binary");
  });

  test("the cap is the one the client's own validator implies", () => {
    expect(QUEUE_READ_MAX_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe("the reader is the only thing that spawns the queue in the web routes", () => {
  test("serve.ts resolves the queue through queueRead, never through the agent resolver", () => {
    // E41's lesson: a guard that only covers one file stops guarding the day the call moves.
    const source = readFileSync(join(import.meta.dir, "..", "src", "web", "serve.ts"), "utf8");
    expect(source).not.toContain("rustAgentBin()");
    expect(source.match(/runQueueRead\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("no route spawns a queue subcommand of its own any more", () => {
    // The guard above catches the resolver; this one catches the deadline. A route that grows its
    // own Bun.spawn gets back an unkillable SIGTERM-only watchdog with an unbounded read.
    const source = readFileSync(join(import.meta.dir, "..", "src", "web", "serve.ts"), "utf8");
    expect(source).not.toContain("Bun.spawn([bin");
    expect(source).not.toContain("new Response(child.stdout).text()");
  });
});
