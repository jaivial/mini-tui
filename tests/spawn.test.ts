import { describe, expect, test } from "bun:test";

import { miniBin, type SessionPaths } from "../src/config";
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
      miniBin(),
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

  test("the Rust agent: the default when its binary is there, with the same arguments", () => {
    const old = { agent: process.env.MINITUI_AGENT, bin: process.env.MINITUI_AGENT_BIN, embedded: process.env.MINITUI_EMBEDDED_AGENT };
    process.env.MINITUI_AGENT = "rust";
    process.env.MINITUI_AGENT_BIN = "/bin/true"; // any existing file stands in for the binary
    delete process.env.MINITUI_EMBEDDED_AGENT;
    try {
      setRunnerSupport(undefined);
      expect(detectRunner()).toBe("rust");
      expect(buildRunnerCommand({ task: "fix it", model: "m", compactOnly: false }, SESSION, "rust")).toEqual([
        "/bin/true", "-y", "--exit-immediately", "-o", "/runs/x/traj.json", "-m", "m", "-t", "fix it",
      ]);
      // A missing binary falls back to the Python agent instead of failing every run.
      process.env.MINITUI_AGENT_BIN = "/nonexistent/mini-agent-rs";
      expect(detectRunner()).not.toBe("rust");
      // An explicit `mini` launcher (MINITUI_EMBEDDED_AGENT=0) always wins.
      process.env.MINITUI_AGENT_BIN = "/bin/true";
      process.env.MINITUI_EMBEDDED_AGENT = "0";
      expect(detectRunner()).toBe("cli");
      delete process.env.MINITUI_EMBEDDED_AGENT;
      // Rust is the default whenever its binary is there, asked for or not; `python` opts out.
      delete process.env.MINITUI_AGENT;
      expect(detectRunner()).toBe("rust");
      process.env.MINITUI_AGENT = "python";
      expect(detectRunner()).not.toBe("rust");
    } finally {
      for (const [k, v] of [["MINITUI_AGENT", old.agent], ["MINITUI_AGENT_BIN", old.bin], ["MINITUI_EMBEDDED_AGENT", old.embedded]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      setRunnerSupport(undefined);
    }
  });

  test("the Rust agent also runs the helpers: `title` answers with a JSON string, no Python", async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "rs-helper-"));
    // A stand-in binary that records its argv and prints a title.
    const bin = join(dir, "mini-agent-rs");
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > ${join(dir, "argv")}\necho '"From Rust"'\n`);
    chmodSync(bin, 0o755);
    const old = { agent: process.env.MINITUI_AGENT, bin: process.env.MINITUI_AGENT_BIN };
    process.env.MINITUI_AGENT = "rust";
    process.env.MINITUI_AGENT_BIN = bin;
    try {
      const { generateTitle } = await import("../src/title");
      const title = await new Promise<string>((resolve) => {
        let got = "";
        generateTitle("the task", "cliproxy/m", (t) => (got = t), () => resolve(got));
      });
      expect(title).toBe("From Rust");
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(join(dir, "argv"), "utf8").trim().split("\n")).toEqual(["title", "the task", "cliproxy/m"]);
    } finally {
      for (const [k, v] of [["MINITUI_AGENT", old.agent], ["MINITUI_AGENT_BIN", old.bin]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a run tells the Rust agent where the bundled YAML configs are, unless one was chosen", () => {
    const old = process.env.MINI_AGENT_CONFIG_DIR;
    delete process.env.MINI_AGENT_CONFIG_DIR;
    try {
      const dir = buildRunEnv(SESSION).MINI_AGENT_CONFIG_DIR!;
      expect(dir.endsWith("/agent/src/minisweagent/config")).toBe(true);
      expect(require("node:fs").existsSync(`${dir}/mini.yaml`)).toBe(true);
      expect(buildRunEnv(SESSION, { MINI_AGENT_CONFIG_DIR: "/mine" }).MINI_AGENT_CONFIG_DIR).toBe("/mine");
      process.env.MINI_AGENT_CONFIG_DIR = "/from-env";
      expect(buildRunEnv(SESSION).MINI_AGENT_CONFIG_DIR).toBe("/from-env");
    } finally {
      if (old === undefined) delete process.env.MINI_AGENT_CONFIG_DIR;
      else process.env.MINI_AGENT_CONFIG_DIR = old;
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
