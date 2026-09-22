import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { slimMessage } from "../src/traj/slim";
import { watchTrajectory } from "../src/traj/watch";
import type { Trajectory, TrajectoryMessage } from "../src/traj/schema";

const heavy = (i: number): TrajectoryMessage => ({
  role: "tool",
  content: `out-${i}`,
  tool_call_id: `c${i}`,
  extra: { raw_output: "x".repeat(10_000), response: { big: "y".repeat(10_000) }, returncode: 0, actions: [{ command: "ls" }] },
});

describe("slim messages", () => {
  test("drops API responses and raw output copies, keeps what --resume and parsing need", () => {
    const slim = slimMessage(heavy(1));
    expect(slim.extra).toEqual({ returncode: 0, actions: [{ command: "ls" }] });
    expect(slim.content).toBe("out-1");
    expect(slim.tool_call_id).toBe("c1");
    const light = { role: "user", content: "hi", extra: { interrupt_type: "UserNewTask" } };
    expect(slimMessage(light)).toBe(light); // nothing to drop → same object, no copy
  });

  test("the watcher hands full messages to the consumer once, then only retains slim ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mini-tui-slim-"));
    const journal = join(dir, "traj.jsonl");
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    writeFileSync(journal, line({ t: "meta" }) + line({ t: "msg", m: heavy(1) }));
    // the contract: a snapshot is read synchronously inside the callback (App turns it into events)
    const seen: Array<{ n: number; newestRaw: boolean; firstRaw: boolean }> = [];
    const handle = watchTrajectory(
      join(dir, "traj.json"),
      (traj: Trajectory) => {
        const m = traj.messages!;
        seen.push({ n: m.length, newestRaw: m[m.length - 1]!.extra?.raw_output !== undefined, firstRaw: m[0]!.extra?.raw_output !== undefined });
      },
      { intervalMs: 10 },
    );
    await Bun.sleep(40);
    appendFileSync(journal, line({ t: "msg", m: heavy(2) }));
    await Bun.sleep(40);
    handle.stop();
    rmSync(dir, { recursive: true, force: true });

    expect(seen[0]).toEqual({ n: 1, newestRaw: true, firstRaw: true }); // new messages arrive complete
    expect(seen[seen.length - 1]).toEqual({ n: 2, newestRaw: true, firstRaw: false }); // older ones retained slim
  });
});
