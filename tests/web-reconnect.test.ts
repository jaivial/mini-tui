/**
 * The one reconnect policy, and the guard that keeps it the only one (E50).
 *
 * The bug this pins: three copies of "reconnect with backoff" lived in the client surface and had
 * diverged — the hub reset its delay when a socket merely OPENED, so a server that accepted and
 * dropped was hammered 33 times in 3 s while the copy with the rule backed off (6 attempts, gaps
 * 85 → 1315 ms). The rule now lives in the type: there is no API that resets from `onopen`.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Reconnect } from "../web/src/lib/reconnect";

const ROOT = join(import.meta.dir, "..", "web", "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("the reconnect policy", () => {
  test("the delay grows exponentially, is capped, and is jittered", () => {
    const r = new Reconnect({ baseDelay: 100, maxDelay: 1_000, random: () => 1 });
    expect(r.attempts).toBe(0);
    expect(r.nextDelay()).toBe(100);
    expect(r.nextDelay()).toBe(200);
    expect(r.nextDelay()).toBe(400);
    expect(r.nextDelay()).toBe(800);
    expect(r.nextDelay()).toBe(1_000); // capped
    expect(r.nextDelay()).toBe(1_000);
    expect(r.attempts).toBe(6);
    const half = new Reconnect({ baseDelay: 100, maxDelay: 1_000, random: () => 0 });
    expect(half.nextDelay()).toBe(50); // jitter never goes below half the cap
  });

  test("only a real delivery resets the count; an accepted connection is not proof", () => {
    const r = new Reconnect({ baseDelay: 10, maxDelay: 80, random: () => 1 });
    r.nextDelay();
    r.nextDelay();
    expect(r.attempts).toBe(2);
    r.delivered();
    expect(r.attempts).toBe(0);
  });

  test("a connection that stayed up counts as proof even if it never said anything", () => {
    const r = new Reconnect({ baseDelay: 10, maxDelay: 80, stableMs: 1_000, random: () => 1 });
    r.nextDelay();
    r.closing(20); // short-lived and silent: still a failure streak
    expect(r.attempts).toBe(1);
    r.closing(2_000); // a stream quiet for hours was working
    expect(r.attempts).toBe(0);
  });
});

describe("one policy, not four (source guard, the E48 whitelist pattern)", () => {
  const files = walk(ROOT).filter((p) => p.endsWith(".ts") || p.endsWith(".svelte") || p.endsWith(".svelte.ts"));
  const rel = (p: string) => p.slice(ROOT.length + 1);

  test("no backoff arithmetic outside reconnect.ts", () => {
    const offenders = files.filter((p) => rel(p) !== join("lib", "reconnect.ts") && /2\s*\*\*/.test(readFileSync(p, "utf8")));
    expect(offenders.map(rel)).toEqual([]);
  });

  test("every client that reconnects takes its delay from the shared policy", () => {
    const must = ["lib/hub.ts", "lib/session-socket.ts", "lib/queueEventsClient.ts", join("lib", "stores", "sessions.svelte.ts")];
    for (const file of must) {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text, `${file} must construct the shared Reconnect`).toContain("new Reconnect(");
      expect(text, `${file} must not keep its own retry arithmetic`).not.toMatch(/2\s*\*\*/);
    }
  });
});
