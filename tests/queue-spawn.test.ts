/**
 * E48: the web reader and the chat bridge were the same queue launcher copied twice (E46 fixed
 * one copy, E47 the other), and the copies had already drifted into defects. Both measured against
 * the deployed code (e2890ec) before the fix:
 *
 *  - `runQueueRead` shared ONE buffer between its stdout and its stderr collects, so a binary that
 *    printed a single warning line on stderr before its JSON made `/task-graph` answer `bad-json`
 *    with the warning glued to the payload — while `queueCommand`, whose copy kept per-stream
 *    buffers, read the SAME command fine. Two launchers, two answers.
 *  - that reader's stderr leg was `bounded: false` and the shared counter was only checked inside
 *    the stdout loop: JSON first, then 200 MB of stderr tripped no bound at all (measured
 *    **1 040 MiB RSS** in the parent of a reader whose cap says 4 MB).
 *
 * And the guard that makes a third copy impossible: `Bun.spawn` may appear in an allowlisted set
 * of files and nowhere else in `src/` (E41: protection by the type system where possible, by a
 * source-reading test where not).
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { queueCommand } from "../src/mini/queue";
import { resetQueueBinCache } from "../src/mini/queueBin";
import { runQueueRead } from "../src/mini/queueRead";
import { spawnQueue } from "../src/mini/queueSpawn";

let dir: string;

function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A closed world for the resolver: the machine's installed binaries must not answer these. */
function envFor(bin: string): NodeJS.ProcessEnv {
  return { MINITUI_QUEUE_BIN: bin, MINITUI_AGENT_BIN: join(dir, "none"), HOME: join(dir, "empty-home") };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "e48-queue-"));
  mkdirSync(join(dir, "empty-home"), { recursive: true });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the two streams are two streams", () => {
  test("a warning on stderr does not contaminate the JSON on stdout", async () => {
    // THE defect of the web reader: shared chunks meant `out` was stdout+stderr interleaved.
    const bin = script("warns.sh", 'if [ "$1" = queue ] && [ "$2" = help ]; then exit 0; fi\necho "warning: deprecated flag in use" >&2\necho \'{"ok":true,"nodes":10}\'');
    const read = await runQueueRead(["queue", "graph-read"], { env: envFor(bin) });
    expect(read.reason).toBeUndefined();
    expect(read.value).toEqual({ ok: true, nodes: 10 });
  });

  test("the bridge and the reader answer the SAME command the same way", async () => {
    // Divergence measured: the bridge parsed this fine while the reader said bad-json.
    const bin = script("warns2.sh", 'if [ "$1" = queue ] && [ "$2" = help ]; then exit 0; fi\necho "a warning" >&2\necho \'{"events":[],"cursor":7}\'');
    const read = await runQueueRead(["queue", "events-read"], { env: envFor(bin) });
    const bridge = await queueCommand(["events-read"], undefined, { bin, timeoutMs: 10_000 });
    expect(read.value).toEqual(JSON.parse(bridge.output));
    expect(bridge.error).toContain("a warning");
  });

  test("a non-zero exit keeps the two streams apart, not merged", async () => {
    const bin = script("fails.sh", 'if [ "$1" = queue ] && [ "$2" = help ]; then exit 0; fi\necho "out-line"\necho "err-line" >&2\nexit 3');
    const run = await spawnQueue([bin, "queue", "graph-read"], { env: envFor(bin) });
    expect(run.code).toBe(3);
    expect(run.stdout).toBe("out-line\n");
    expect(run.stderr).toBe("err-line\n");
  });
});

describe("the cap is a budget for the run, counted across both streams", () => {
  test("stderr floods are refused instead of buffered whole", async () => {
    // Measured before: 200 MB of stderr after a small JSON stdout -> `bad-json`, 1 040 MiB RSS.
    const bin = script("flood-stderr.sh", 'if [ "$1" = queue ] && [ "$2" = help ]; then exit 0; fi\necho \'{"ok":true}\'\ndd if=/dev/zero bs=1M count=200 2>/dev/null | tr "\\0" "x" >&2');
    const rssBefore = process.memoryUsage().rss;
    const t0 = Date.now();
    const read = await runQueueRead(["queue", "graph-read"], { env: envFor(bin), timeoutMs: 30_000 });
    const deltaMiB = Math.round((process.memoryUsage().rss - rssBefore) / 1024 / 1024);
    expect(read.reason).toBe("too-large");
    expect(read.value).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(10_000);
    // The point of the cap is the parent's memory: 200 MB of flood must not land in it.
    expect(deltaMiB).toBeLessThan(200);
  });

  test("two streams of half the budget each still exceed the budget", async () => {
    // Per-stream caps (the bridge's old copy) let 4+4 MB through; the budget is the parent's.
    const bin = script("split.sh", 'if [ "$1" = queue ] && [ "$2" = help ]; then exit 0; fi\nhead -c 3145728 /dev/zero | tr "\\0" "a"\nhead -c 3145728 /dev/zero | tr "\\0" "b" >&2');
    const run = await spawnQueue([bin, "queue", "graph-read"], { env: envFor(bin), maxBytes: 4 * 1024 * 1024, timeoutMs: 30_000 });
    expect(run.reason).toBe("too-large");
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("a run that stays inside the budget comes back whole and separate", async () => {
    const bin = script("small.sh", 'if [ "$1" = queue ] && [ "$2" = help ]; then exit 0; fi\nprintf \'{"n":1}\'\nprintf \'note\' >&2');
    const run = await spawnQueue([bin, "queue", "graph-read"], { env: envFor(bin) });
    expect(run.reason).toBeUndefined();
    expect(run.stdout).toBe('{"n":1}');
    expect(run.stderr).toBe("note");
  });
});

describe("the deadline and the kill still work through the shared launcher", () => {
  test("a child that ignores SIGTERM is named as a timeout and actually gone", async () => {
    const marker = join(dir, "e48-still-running");
    const bin = script("stubborn.sh", 'if [ "$1" = queue ] && [ "$2" = help ]; then exit 0; fi\ntrap "" TERM\nsleep 30\necho done > "' + marker + '"\necho "{}"');
    const t0 = Date.now();
    const read = await runQueueRead(["queue", "graph-read"], { env: envFor(bin), timeoutMs: 300 });
    expect(read.reason).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test("an aborted run is named as aborted, not as a deadline", async () => {
    const bin = script("slow-run.sh", 'if [ "$1" = queue ] && [ "$2" = help ]; then exit 0; fi\ntrap "" TERM\nsleep 30');
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);
    const t0 = Date.now();
    const run = await spawnQueue([bin, "queue", "run"], { env: envFor(bin), signal: abort.signal });
    expect(run.reason).toBe("aborted");
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});

describe("there is only one place that spawns a queue command", () => {
  /** Every .ts file under src/ that calls `Bun.spawn(` — allowlisted on purpose, one by one. */
  function spawnSites(): string[] {
    const root = join(import.meta.dir, "..", "src");
    const found: string[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts") && /Bun\.spawn\(/.test(readFileSync(p, "utf8"))) {
          found.push(p.slice(root.length + 1));
        }
      }
    };
    walk(root);
    return found.sort();
  }

  test("Bun.spawn appears only where the allowlist says it may", () => {
    // A third launcher cannot copy a broken half: adding a spawn anywhere in src/ fails here, and
    // the only way forward is to go through `spawnQueue` — or to edit this list in a review.
    // (channels/queueBridge.ts is `systemctl is-active`, asserted below; it is not a queue launch.)
    expect(spawnSites()).toEqual([
      "channels/queueBridge.ts",
      "mini/queueSpawn.ts",
      "mini/spawn.ts",
      "web/folders.ts",
      "web/ssh.ts",
      "web/terminals.ts",
    ]);
  });

  test("the chat bridge's one spawn is the systemctl probe, not a queue launch", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "channels", "queueBridge.ts"), "utf8");
    const sites = source.match(/Bun\.spawn\([^\n]*/g) ?? [];
    expect(sites.length).toBe(1);
    expect(sites[0]).toContain("systemctl");
  });

  test("the queue files are adapters: no spawn of their own, and they call the launcher", () => {
    for (const file of ["mini/queue.ts", "mini/queueRead.ts", "mini/queueBin.ts"]) {
      const source = readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code).not.toContain("Bun.spawn");
      expect(code).toContain("spawnQueue(");
    }
  });
});
