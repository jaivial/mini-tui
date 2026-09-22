import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { journalPathFor, readTrajectory, watchTrajectory } from "../src/traj/watch";
import type { TrajectoryMessage } from "../src/traj/schema";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "mini-tui-journal-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const msg = (n: number): TrajectoryMessage => ({ role: "assistant", content: `m${n}` });
const line = (entry: Record<string, unknown>) => `${JSON.stringify(entry)}\n`;

describe("trajectory journal", () => {
  test("journalPathFor mirrors Python's Path.with_suffix", () => {
    expect(journalPathFor("/x/traj.json")).toBe("/x/traj.jsonl");
    expect(journalPathFor("/x/foo.traj.json")).toBe("/x/foo.traj.jsonl");
    expect(journalPathFor("/x/traj")).toBe("/x/traj.jsonl");
  });

  test("readTrajectory replays meta, messages and info from the journal", () => {
    const dir = tmp();
    const journal = join(dir, "traj.jsonl");
    writeFileSync(
      journal,
      line({ t: "meta", trajectory_format: "mini-swe-agent-1.1" }) +
        line({ t: "msg", m: msg(1) }) +
        line({ t: "msg", m: msg(2) }) +
        line({ t: "info", i: { exit_status: "Submitted", submission: "done" } }),
    );
    const read = readTrajectory(join(dir, "traj.json"));
    expect(read?.messages?.map((m) => m.content)).toEqual(["m1", "m2"]);
    expect(read?.info?.exit_status).toBe("Submitted");
    expect(read?.info?.submission).toBe("done");
    expect(read?.trajectory_format).toBe("mini-swe-agent-1.1");
  });

  test("a partial trailing line waits for the rest of the append", () => {
    const dir = tmp();
    const journal = join(dir, "traj.jsonl");
    writeFileSync(journal, line({ t: "msg", m: msg(1) }) + line({ t: "msg", m: msg(2) }).slice(0, 10));
    expect(readTrajectory(join(dir, "traj.json"))?.messages?.map((m) => m.content)).toEqual(["m1"]);
    appendFileSync(journal, line({ t: "msg", m: msg(2) }).slice(10));
    expect(readTrajectory(join(dir, "traj.json"))?.messages?.map((m) => m.content)).toEqual(["m1", "m2"]);
  });

  test("watch consumes only the appended lines and keeps the messages array growing", async () => {
    const dir = tmp();
    const traj = join(dir, "traj.json");
    const journal = join(dir, "traj.jsonl");
    writeFileSync(journal, line({ t: "meta", trajectory_format: "mini-swe-agent-1.1" }) + line({ t: "msg", m: msg(1) }));

    const snapshots: number[] = [];
    let lastMessages: TrajectoryMessage[] | undefined;
    const watch = watchTrajectory(
      traj,
      (snap) => {
        snapshots.push(snap.messages?.length ?? 0);
        lastMessages = snap.messages;
      },
      { intervalMs: 5 },
    );
    await Bun.sleep(30); // no new bytes: no new snapshots
    appendFileSync(journal, line({ t: "msg", m: msg(2) }) + line({ t: "info", i: { exit_status: "" } }));
    await Bun.sleep(30);
    appendFileSync(journal, line({ t: "msg", m: msg(3) }) + line({ t: "info", i: { exit_status: "Submitted" } }));
    await Bun.sleep(30);
    watch.stop();

    expect(snapshots).toEqual([1, 2, 3]);
    expect(lastMessages?.map((m) => m.content)).toEqual(["m1", "m2", "m3"]);
  });

  test("truncation (a new run reusing the path) resets the accumulation", async () => {
    const dir = tmp();
    const journal = join(dir, "traj.jsonl");
    writeFileSync(
      journal,
      line({ t: "msg", m: msg(1) }) + line({ t: "msg", m: msg(2) }) + line({ t: "msg", m: msg(3) }),
    );
    const snapshots: number[] = [];
    const watch = watchTrajectory(
      join(dir, "traj.json"),
      (snap) => snapshots.push(snap.messages?.length ?? 0),
      { intervalMs: 5 },
    );
    await Bun.sleep(30);
    writeFileSync(journal, line({ t: "msg", m: msg(9) })); // truncated + rewritten
    await Bun.sleep(30);
    watch.stop();
    expect(snapshots).toEqual([3, 1]);
  });

  test("falls back to the whole export when there is no journal", async () => {
    const dir = tmp();
    const traj = join(dir, "traj.json");
    writeFileSync(traj, JSON.stringify({ messages: [msg(1)], info: {}, trajectory_format: "mini-swe-agent-1.1" }));
    const snapshots: number[] = [];
    const watch = watchTrajectory(traj, (snap) => snapshots.push(snap.messages?.length ?? 0), { intervalMs: 5 });
    await Bun.sleep(30);
    writeFileSync(
      traj,
      JSON.stringify({ messages: [msg(1), msg(2)], info: {}, trajectory_format: "mini-swe-agent-1.1" }),
    );
    await Bun.sleep(30);
    watch.stop();
    expect(snapshots).toEqual([1, 2]);
  });
});
