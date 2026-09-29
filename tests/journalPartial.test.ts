import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { watchTrajectory } from "../src/traj/watch";
import type { Trajectory } from "../src/traj/schema";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function journal() {
  const dir = mkdtempSync(join(tmpdir(), "partial-"));
  const traj = join(dir, "traj.json");
  const lines = join(dir, "traj.jsonl");
  writeFileSync(traj, "{}");
  writeFileSync(lines, JSON.stringify({ t: "meta", trajectory_format: "mini-tui" }) + "\n");
  return { dir, traj, lines };
}

describe("journal partial output", () => {
  test("delta records accumulate per channel and never count as a message", async () => {
    const { dir, traj, lines } = journal();
    const seen: Trajectory[] = [];
    const handle = watchTrajectory(traj, (t) => seen.push(t), { intervalMs: 20 });
    await wait(80);

    appendFileSync(lines, JSON.stringify({ t: "delta", k: "thinking", x: "Let me " }) + "\n");
    appendFileSync(lines, JSON.stringify({ t: "delta", k: "thinking", x: "check." }) + "\n");
    appendFileSync(lines, JSON.stringify({ t: "delta", k: "text", x: "Running ls." }) + "\n");
    await wait(140);
    handle.stop();

    const withPartial = seen.filter((t) => t.partial);
    expect(withPartial.length).toBeGreaterThan(0);
    expect(withPartial[withPartial.length - 1]!.partial).toEqual({
      thinking: "Let me check.",
      text: "Running ls.",
    });
    // A fragment is not a message: nothing here may be rendered as a finished reply.
    expect(seen.every((t) => (t.messages ?? []).length === 0)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the real message supersedes the partial view", async () => {
    const { dir, traj, lines } = journal();
    const seen: Trajectory[] = [];
    const handle = watchTrajectory(traj, (t) => seen.push(t), { intervalMs: 20 });
    await wait(80);

    appendFileSync(lines, JSON.stringify({ t: "delta", k: "text", x: "Running ls." }) + "\n");
    await wait(100);
    appendFileSync(
      lines,
      JSON.stringify({ t: "msg", m: { role: "assistant", content: "Running ls." } }) + "\n",
    );
    await wait(140);
    handle.stop();

    const tail = seen[seen.length - 1]!;
    expect(tail.partial).toBeUndefined();
    expect(tail.messages).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a torn delta line is ignored, not rendered as half a word", async () => {
    const { dir, traj, lines } = journal();
    const seen: Trajectory[] = [];
    const handle = watchTrajectory(traj, (t) => seen.push(t), { intervalMs: 20 });
    await wait(80);

    // A writer mid-append: the JSON is not yet complete.
    appendFileSync(lines, '{"t":"delta","k":"text","x":"half');
    await wait(100);
    expect(seen.every((t) => !t.partial)).toBe(true);

    appendFileSync(lines, '-word"}\n');
    await wait(120);
    handle.stop();
    expect(seen[seen.length - 1]!.partial).toEqual({ thinking: "", text: "half-word" });
    rmSync(dir, { recursive: true, force: true });
  });
});
