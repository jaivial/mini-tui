import { describe, expect, test } from "bun:test";

import { MINI_BIN, type SessionPaths } from "../src/config";
import { buildMiniArgs } from "../src/mini/spawn";

const SESSION: SessionPaths = {
  dir: "/runs/x",
  trajPath: "/runs/x/traj.json",
  logPath: "/runs/x/mini.log",
  pidPath: "/runs/x/pid",
  controlPath: "/runs/x/control",
};

describe("buildMiniArgs", () => {
  test("plain run: yolo, output and task", () => {
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

  test("resumed run: --resume carries the conversation history", () => {
    const args = buildMiniArgs({ task: "and then?", resumePath: "/resume/s1.json" }, SESSION);
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("/resume/s1.json");
    // before -m/-t so option parsing stays unambiguous
    expect(args.indexOf("--resume")).toBeLessThan(args.indexOf("-t"));
  });
});
