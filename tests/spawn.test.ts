import { describe, expect, test } from "bun:test";

import { MINI_BIN, type SessionPaths } from "../src/config";
import { buildMiniArgs, buildRunEnv, buildRunnerCommand, detectRunner, setRunnerSupport } from "../src/mini/spawn";

const SESSION: SessionPaths = {
  dir: "/runs/x",
  trajPath: "/runs/x/traj.json",
  logPath: "/runs/x/mini.log",
  pidPath: "/runs/x/pid",
  controlPath: "/runs/x/control",
};

describe("mini argument builders", () => {
  test("plain public run: yolo, output and task", () => {
    expect(buildMiniArgs({ task: "fix it", model: "xiaomi/mimo-v2.6-pro" }, SESSION)).toEqual([
      MINI_BIN,
      "-y",
      "--exit-immediately",
      "-o",
      "/runs/x/traj.json",
      "-m",
      "xiaomi/mimo-v2.6-pro",
      "-t",
      "fix it",
    ]);
  });

  test("resumed public run carries the conversation history", () => {
    const args = buildMiniArgs({ task: "and then?", resumePath: "/resume/s1.json" }, SESSION);
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("/resume/s1.json");
    expect(args.indexOf("--resume")).toBeLessThan(args.indexOf("-t"));
  });

  test("embedded runner omits the public mini launcher and keeps all overrides", () => {
    setRunnerSupport("embedded");
    try {
      const command = buildRunnerCommand(
      { task: "fix it", model: "xiaomi/mimo-v2.6-pro", specs: ["agent.step_limit=1"], resumePath: "/resume/s1.json" },
        SESSION,
        "embedded",
      );
      expect(command.slice(2)).toEqual([
        "minisweagent.run.tui",
        "-y",
        "--exit-immediately",
        "-o",
        "/runs/x/traj.json",
        "--resume",
        "/resume/s1.json",
        "-m",
        "xiaomi/mimo-v2.6-pro",
        "-c",
        "agent.step_limit=1",
        "-t",
        "fix it",
      ]);
    } finally {
      setRunnerSupport(undefined);
    }
  });

  test("embedded runner can be disabled for the public CLI fallback", () => {
    const old = process.env.MINITUI_EMBEDDED_AGENT;
    process.env.MINITUI_EMBEDDED_AGENT = "0";
    try {
      setRunnerSupport(undefined);
      expect(detectRunner()).toBe("cli");
    } finally {
      if (old === undefined) delete process.env.MINITUI_EMBEDDED_AGENT;
      else process.env.MINITUI_EMBEDDED_AGENT = old;
      setRunnerSupport(undefined);
    }
  });

  test("run environment owns the control channel and is silent", () => {
    const old = process.env.MSWEA_CONTROL_FILE;
    process.env.MSWEA_CONTROL_FILE = "/stale/control";
    try {
      const env = buildRunEnv(SESSION, { FROM_CONNECTION: "yes" });
      expect(env.MSWEA_CONTROL_FILE).toBe(SESSION.controlPath);
      expect(env.MSWEA_SILENT_STARTUP).toBe("1");
      expect(env.FROM_CONNECTION).toBe("yes");
    } finally {
      if (old === undefined) delete process.env.MSWEA_CONTROL_FILE;
      else process.env.MSWEA_CONTROL_FILE = old;
    }
  });
});
