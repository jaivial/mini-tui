/**
 * Regression: a single tool result of hundreds of MB must not be retained in memory.
 *
 * The 2026-10-05 OOM: one run's journal held three tool messages of 437 MB, 371 MB and
 * 147 MB, so the trajectory was 962 MB. Opening that session in the web app parsed the
 * whole journal and kept every message, peaking at 4.3 GB RSS on a single read (4.4x the
 * file) and re-reading it on every 200 ms poll. The bound that exists for display
 * (boundText) only ran later, in parse.ts, so it capped what was *rendered* and never
 * what was *held*.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { OUTPUT_MAX_CHARS, boundText, slimMessage } from "../src/traj/slim";
import { journalPathFor, readTrajectory, watchTrajectory } from "../src/traj/watch";

/** A tool result as big as the ones that killed the box, without allocating it twice. */
function hugeMessage(mb: number) {
  return { t: "msg", m: { role: "tool", content: "A".repeat(mb * 1024 * 1024), tool_call_id: "c1" } };
}

describe("huge tool output", () => {
  test("boundText caps a single oversized block and notes what was dropped", () => {
    const text = "line\n".repeat(200_000) + "TAIL\n";
    const bounded = boundText(text);
    expect(bounded.length).toBeLessThanOrEqual(OUTPUT_MAX_CHARS + 4_000);
    expect(bounded).toMatch(/lines hidden|truncated/); // the reader is told what was dropped
    expect(bounded).toContain("TAIL"); // the tail the collapsed view shows
    expect(boundText("small")).toBe("small"); // untouched below the cap
  });

  test("slimMessage bounds content as well as dropping the heavy extras", () => {
    const slim = slimMessage({ role: "tool", content: "A".repeat(5_000_000), tool_call_id: "c" });
    expect((slim.content as string).length).toBeLessThan(OUTPUT_MAX_CHARS + 4_000);
  });

  test("readTrajectory retains a bounded copy, not the multi-hundred-MB original", () => {
    const dir = mkdtempSync(join(tmpdir(), "mini-tui-huge-"));
    try {
      const traj = join(dir, "traj.json");
      writeFileSync(traj, "{}");
      // 8 MB stands in for the 437 MB one: same shape, cheap to build in a test.
      appendFileSync(journalPathFor(traj), `${JSON.stringify(hugeMessage(8))}\n`);

      const size = statSync(journalPathFor(traj)).size;
      expect(size).toBeGreaterThan(4 * 1024 * 1024); // the fixture really is big

      const messages = readTrajectory(traj)!.messages!;
      const retained = messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
      expect(retained).toBeLessThan(size / 10); // an order of magnitude less than on disk
      expect(retained).toBeLessThanOrEqual(OUTPUT_MAX_CHARS * messages.length + 4_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the whole-export fallback bounds too (no journal present)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mini-tui-huge-export-"));
    try {
      const traj = join(dir, "traj.json");
      writeFileSync(traj, JSON.stringify({ messages: [hugeMessage(4).m] }));
      const c = readTrajectory(traj)!.messages![0]!.content as string;
      expect(c.length).toBeLessThan(OUTPUT_MAX_CHARS + 4_000);
      expect(c).toContain("truncated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the watcher keeps polling a big journal without growing without bound", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mini-tui-huge-watch-"));
    try {
      const traj = join(dir, "traj.json");
      writeFileSync(traj, "{}");
      const journal = journalPathFor(traj);
      appendFileSync(journal, `${JSON.stringify(hugeMessage(4))}\n`);

      let peak = 0;
      let held = 0;
      const handle = watchTrajectory(traj, (t) => {
        held = (t.messages ?? []).reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
        peak = Math.max(peak, process.memoryUsage().rss);
      }, { intervalMs: 20 });
      // Keep appending, as a live run does: every poll must stay bounded.
      for (let i = 0; i < 3; i++) {
        appendFileSync(journal, `${JSON.stringify({ t: "delta", k: "text", x: "more" })}\n`);
        await Bun.sleep(60);
      }
      handle.stop();

      expect(held).toBeLessThanOrEqual(OUTPUT_MAX_CHARS + 4_000);
      expect(peak).toBeLessThan(512 * 1024 * 1024); // not a multi-GB spike
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
