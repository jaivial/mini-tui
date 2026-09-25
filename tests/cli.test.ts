import { describe, expect, test } from "bun:test";

import { headlessSpecs, parseArgs, UsageError, withDefaultConfig, type HeadlessArgs } from "../src/cli/args";
import { combinePrompt, finalAnswer, formatEventText, streamEvent, turnStartIndex } from "../src/cli/headless";
import { buildRunEnv } from "../src/mini/spawn";
import type { RunEvent } from "../src/traj/schema";

const SESSION = { dir: "/r", trajPath: "/r/traj.json", logPath: "/r/mini.log", pidPath: "/r/pid", controlPath: "/r/control" };

describe("parseArgs: TUI entry points keep working", () => {
  test("bare invocation opens the prompt", () => {
    expect(parseArgs([])).toEqual({ command: "run" });
  });
  test("run with task, model and config", () => {
    expect(parseArgs(["run", "fix", "it", "-m", "x/y", "-c", "agent.step_limit=3"])).toEqual({
      command: "run",
      task: "fix it",
      model: "x/y",
      specs: ["agent.step_limit=3"],
    });
  });
  test("bare flags without a subcommand are a TUI run", () => {
    expect(parseArgs(["-m", "x/y"])).toEqual({ command: "run", model: "x/y" });
  });
  test("view needs a path", () => {
    expect(parseArgs(["view", "t.json", "--follow"])).toEqual({ command: "view", viewPath: "t.json", follow: true });
    expect(() => parseArgs(["view"])).toThrow(UsageError);
  });
  test("help, version and unknown commands", () => {
    expect(parseArgs(["--help"])).toEqual({ command: "help" });
    expect(parseArgs(["-V"])).toEqual({ command: "version" });
    expect(() => parseArgs(["frobnicate"])).toThrow(/unknown command/);
    expect(() => parseArgs(["run", "--nope"])).toThrow(/unknown option/);
  });
});

describe("parseArgs: headless -p", () => {
  const base = (over: Partial<HeadlessArgs> = {}): HeadlessArgs => ({
    command: "print",
    prompt: "",
    outputFormat: "text",
    verbose: false,
    quiet: false,
    continueLast: false,
    noSession: false,
    compact: false,
    ...over,
  });
  test("prompt anywhere around -p", () => {
    expect(parseArgs(["-p", "fix the bug"])).toEqual(base({ prompt: "fix the bug" }));
    expect(parseArgs(["fix", "-p", "the", "bug"])).toEqual(base({ prompt: "fix the bug" }));
    expect(parseArgs(["run", "--print", "-t", "hello"])).toEqual(base({ prompt: "hello" }));
  });
  test("every option", () => {
    const args = parseArgs([
      "-p",
      "go",
      "-m",
      "a/b",
      "-o",
      "stream-json",
      "-v",
      "-r",
      "s-abc",
      "--cwd",
      "/tmp",
      "--max-steps",
      "5",
      "--cost-limit=0.5",
      "--timeout",
      "60",
      "-c",
      "agent.x=1",
      "--no-session",
      "--show-system",
    ]);
    expect(args).toEqual(
      base({
        prompt: "go",
        model: "a/b",
        outputFormat: "stream-json",
        verbose: true,
        resumeId: "s-abc",
        cwd: "/tmp",
        maxSteps: 5,
        costLimit: 0.5,
        timeout: 60,
        specs: ["agent.x=1"],
        noSession: true,
        showSystem: true,
      }),
    );
  });
  test("--json, --continue and --compact", () => {
    expect(parseArgs(["-p", "x", "--json", "-C"])).toEqual(base({ prompt: "x", outputFormat: "json", continueLast: true }));
    expect(parseArgs(["-p", "--compact", "-C"])).toEqual(base({ compact: true, continueLast: true }));
  });
  test("-- ends options (a prompt may start with a dash)", () => {
    expect(parseArgs(["-p", "--", "-v is a flag?"])).toEqual(base({ prompt: "-v is a flag?" }));
  });
  test("-c values with '=' are never split", () => {
    expect((parseArgs(["-p", "x", "-c", "--weird=value"]) as HeadlessArgs).specs).toEqual(["--weird=value"]);
  });
  test("invalid combinations are usage errors", () => {
    expect(() => parseArgs(["-p", "x", "-o", "yaml"])).toThrow(/must be one of text, json, stream-json/);
    expect(() => parseArgs(["-p", "x", "-v", "-q"])).toThrow(/exclude/);
    expect(() => parseArgs(["-p", "x", "-C", "-r", "s1"])).toThrow(/either/);
    expect(() => parseArgs(["-p", "--compact"])).toThrow(/--compact needs/);
    expect(() => parseArgs(["-p", "x", "--max-steps", "1.5"])).toThrow(/whole number/);
    expect(() => parseArgs(["-p", "x", "--cost-limit", "-1"])).toThrow(/>= 0/);
    expect(() => parseArgs(["-p", "x", "-m"])).toThrow(/needs a value/);
    expect(() => parseArgs(["-p", "x", "--follow"])).toThrow(/unknown option for -p/);
  });
});

describe("parseArgs: scripting subcommands", () => {
  test("sessions", () => {
    expect(parseArgs(["sessions"])).toMatchObject({ command: "sessions", action: "list", all: false, limit: 20 });
    expect(parseArgs(["sessions", "--all", "-n", "5", "-s", "bug", "--json"])).toMatchObject({ all: true, limit: 5, query: "bug", json: true });
    expect(parseArgs(["sessions", "show", "s-1"])).toMatchObject({ action: "show", id: "s-1" });
    expect(parseArgs(["sessions", "s-1"])).toMatchObject({ action: "show", id: "s-1" });
    expect(parseArgs(["sessions", "delete", "s-1"])).toMatchObject({ action: "rm", id: "s-1" });
    expect(() => parseArgs(["sessions", "rm"])).toThrow(/needs a session id/);
  });
  test("models, model, skills, settings", () => {
    expect(parseArgs(["models", "--json"])).toEqual({ command: "models", json: true });
    expect(parseArgs(["model"])).toEqual({ command: "model", model: undefined, json: false });
    expect(parseArgs(["model", "x/y"])).toEqual({ command: "model", model: "x/y", json: false });
    expect(parseArgs(["skills"])).toEqual({ command: "skills", json: false });
    expect(parseArgs(["settings", "theme", "nord"])).toEqual({ command: "settings", key: "theme", value: "nord", json: false });
    expect(() => parseArgs(["settings", "theme"])).toThrow(/needs a value/);
  });
});

describe("config specs", () => {
  test("key=value overrides merge into the default config", () => {
    expect(withDefaultConfig([], "mini")).toEqual([]);
    expect(withDefaultConfig(["agent.step_limit=2"], "mini")).toEqual(["mini", "agent.step_limit=2"]);
    expect(withDefaultConfig(["my.yaml", "agent.step_limit=2"], "mini")).toEqual(["my.yaml", "agent.step_limit=2"]);
  });
  test("limit flags become agent specs", () => {
    const args = parseArgs(["-p", "x", "--max-steps", "3", "--cost-limit", "0", "--timeout", "9"]) as HeadlessArgs;
    const specs = headlessSpecs(args);
    expect(specs.slice(1)).toEqual(["agent.step_limit=3", "agent.cost_limit=0", "agent.wall_time_limit_seconds=9"]);
    expect(specs[0]).not.toContain("=");
  });
});

describe("headless helpers", () => {
  test("headless runs have no control channel (the agent exits with the turn)", () => {
    expect(buildRunEnv(SESSION, {}, false).MSWEA_CONTROL_FILE).toBe("");
    expect(buildRunEnv(SESSION).MSWEA_CONTROL_FILE).toBe("/r/control");
  });
  test("piped stdin joins the prompt", () => {
    expect(combinePrompt("explain", "log\n")).toBe("explain\n\nlog");
    expect(combinePrompt("", "only stdin")).toBe("only stdin");
    expect(combinePrompt(" p ", null)).toBe("p");
    expect(combinePrompt("p", "   ")).toBe("p");
  });
  test("final answer: submission, else last assistant text of this turn", () => {
    const events: RunEvent[] = [
      { type: "task", text: "a" },
      { type: "assistant", text: "old reply" },
      { type: "task", text: "b" },
      { type: "tool_call", id: "1", name: "bash", command: "ls" },
    ];
    expect(finalAnswer(events)).toBe("");
    expect(finalAnswer([...events, { type: "assistant", text: "partial" }])).toBe("partial");
    expect(finalAnswer([...events, { type: "exit", exitStatus: "Submitted", submission: "done" }])).toBe("done");
  });
  test("resumed turns start at the new follow-up, never an older one", () => {
    const followUp = { role: "user", content: "x", extra: { interrupt_type: "UserNewTask" } };
    const messages = [{ role: "system" }, { role: "user" }, followUp, { role: "assistant" }, followUp, { role: "assistant" }];
    expect(turnStartIndex(messages, 4)).toBe(4);
    expect(turnStartIndex(messages.slice(0, 4), 4)).toBe(-1);
    expect(turnStartIndex(messages, 0)).toBe(2);
  });
  test("quiet stream-json drops thinking and bounds outputs; verbose keeps all", () => {
    const thinking: RunEvent = { type: "thinking", text: "hmm", seconds: 1 };
    expect(streamEvent(thinking, false)).toBeNull();
    expect(streamEvent(thinking, true)).toEqual(thinking);
    const big: RunEvent = { type: "observation", toolCallId: "1", returncode: 0, output: "x\n".repeat(30000), exceptionInfo: "" };
    const quiet = streamEvent(big, false) as { output: string };
    expect(quiet.output.length).toBeLessThan(big.output.length);
    expect((streamEvent(big, true) as { output: string }).output).toBe(big.output);
  });
  test("verbose text lines", () => {
    expect(formatEventText({ type: "tool_call", id: "1", name: "bash", command: "ls -la" })).toBe("$ ls -la\n");
    expect(formatEventText({ type: "observation", toolCallId: "1", returncode: 2, output: "boom\n", exceptionInfo: "" })).toBe("  boom [exit 2]\n");
    expect(formatEventText({ type: "exit", exitStatus: "Submitted", submission: "" })).toBe("■ Submitted\n");
    expect(formatEventText({ type: "task", text: "hi" }, true)).toContain("\u001b[");
  });
});
