import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import { messagesToEvents, parseTrajectory } from "../src/traj/parse";
import { readTrajectory, watchTrajectory } from "../src/traj/watch";
import type { RunEvent, Trajectory } from "../src/traj/schema";

function loadFixture(name: string): Trajectory {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Trajectory;
}

describe("messagesToEvents", () => {
  test("normal step: task, assistant, tool call, observation, exit", () => {
    const events = messagesToEvents(loadFixture("normal-step").messages ?? []);
    expect(events).toEqual([
      { type: "task", text: "Run 'echo TUI_OK' and submit." },
      { type: "assistant", text: "Running it now.", cost: 0.006 },
      { type: "tool_call", id: "call_1", name: "bash", command: "echo TUI_OK" },
      { type: "observation", toolCallId: "call_1", returncode: 0, output: "TUI_OK\n", exceptionInfo: "" },
      { type: "exit", exitStatus: "Submitted", submission: "Echoed and submitted." },
    ]);
  });

  test("system is dropped unless showSystem is set", () => {
    const messages = loadFixture("normal-step").messages ?? [];
    expect(messagesToEvents(messages).some((e) => e.type === "notice")).toBe(false);
    const withSystem = messagesToEvents(messages, { showSystem: true });
    expect(withSystem[0]).toEqual({
      type: "notice",
      text: "You are a helpful assistant that can interact with a computer.",
      interruptType: "system",
    });
  });

  test("multi-tool step keeps call/observation pairing via tool_call_id", () => {
    const events = messagesToEvents(loadFixture("multi-tool").messages ?? []);
    expect(events.map((e) => e.type)).toEqual(["task", "assistant", "tool_call", "tool_call", "observation", "observation"]);
    const toolCalls = events.filter((e) => e.type === "tool_call") as Extract<RunEvent, { type: "tool_call" }>[];
    expect(toolCalls.map((e) => e.command)).toEqual(["grep -n foo f.txt", "grep -n bar f.txt"]);
    const observations = events.filter((e) => e.type === "observation") as Extract<RunEvent, { type: "observation" }>[];
    expect(observations.map((e) => [e.toolCallId, e.returncode])).toEqual([
      ["call_a", 0],
      ["call_b", 1],
    ]);
  });

  test("observation with exception_info and nonzero returncode", () => {
    const events = messagesToEvents(loadFixture("error-obs").messages ?? []);
    const obs = events.find((e) => e.type === "observation") as Extract<RunEvent, { type: "observation" }>;
    expect(obs.returncode).toBe(2);
    expect(obs.output).toBe("boom\n");
    expect(obs.exceptionInfo).toBe("timed out");
  });

  test("FormatError interrupt becomes a notice", () => {
    const events = messagesToEvents(loadFixture("format-error").messages ?? []);
    const notice = events.find((e) => e.type === "notice") as Extract<RunEvent, { type: "notice" }> | undefined;
    expect(notice?.interruptType).toBe("FormatError");
    expect(notice?.text).toContain("Response not in right format");
  });

  test("exit message carries exit_status and submission", () => {
    const events = messagesToEvents(loadFixture("normal-step").messages ?? []);
    const exit = events.at(-1) as Extract<RunEvent, { type: "exit" }>;
    expect(exit).toEqual({ type: "exit", exitStatus: "Submitted", submission: "Echoed and submitted." });
  });

  test("invalid function.arguments falls back to extra.actions", () => {
    const events = messagesToEvents(loadFixture("weird").messages ?? []);
    const call = events.find((e) => e.type === "tool_call") as Extract<RunEvent, { type: "tool_call" }>;
    expect(call.command).toBe("ls -la");
  });

  test("multimodal content list is joined (images marked)", () => {
    const events = messagesToEvents(loadFixture("weird").messages ?? []);
    const assistant = events.find((e) => e.type === "assistant") as Extract<RunEvent, { type: "assistant" }>;
    expect(assistant.text).toContain("Taking a look:");
    expect(assistant.text).toContain("<image>");
  });

  test("tool message without extra falls back to the content JSON", () => {
    const events = messagesToEvents(loadFixture("weird").messages ?? []);
    const obs = events.find((e) => e.type === "observation") as Extract<RunEvent, { type: "observation" }>;
    expect(obs.returncode).toBe(3);
    expect(obs.output).toBe("oops");
  });

  test("unknown message shape degrades to a notice without throwing", () => {
    const events = messagesToEvents(loadFixture("weird").messages ?? []);
    expect(events.some((e) => e.type === "notice")).toBe(true);
  });

  test("incremental parsing from a consumed index only emits new events", () => {
    const messages = loadFixture("normal-step").messages ?? [];
    const first = messagesToEvents(messages, {}, 0);
    const rest = messagesToEvents(messages, {}, 4);
    expect(rest.every((e) => e.type === "exit"));
    expect([...messagesToEvents(messages.slice(0, 4)), ...rest].map((e) => e.type)).toEqual(first.map((e) => e.type));
  });
});

describe("parseTrajectory", () => {
  test("extracts header info", () => {
    const { info, events } = parseTrajectory(loadFixture("normal-step"));
    expect(info.model).toBe("xiaomi/mimo-v2.6-flash");
    expect(info.cost).toBe(0.0123);
    expect(info.apiCalls).toBe(2);
    expect(info.exitStatus).toBe("Submitted");
    expect(info.trajectoryFormat).toBe("mini-swe-agent-1.1");
    expect(events.length).toBe(5);
  });
});

describe("watchTrajectory", () => {
  test("keeps the last good snapshot across a mid-write read", async () => {
    const dir = mkdtempSync(join(import.meta.dir, ".tmp-"));
    const path = join(dir, "traj.json");
    const full = JSON.stringify(loadFixture("normal-step"));
    writeFileSync(path, full.slice(0, 40)); // half-written JSON, like DefaultAgent.save() mid-write

    const snapshots: Trajectory[] = [];
    const watch = watchTrajectory(path, (traj) => snapshots.push(traj), { intervalMs: 20 });
    await Bun.sleep(80);
    expect(snapshots.length).toBe(0); // partial write must not crash or emit

    writeFileSync(path, full); // the write completes
    await Bun.sleep(120);
    watch.stop();
    rmSync(dir, { recursive: true, force: true });

    expect(snapshots.length).toBe(1);
    expect(snapshots[0]?.messages?.length).toBe(5);
  });

  test("readTrajectory returns null for missing or broken files", () => {
    expect(readTrajectory("/definitely/not/here.json")).toBeNull();
  });
});
