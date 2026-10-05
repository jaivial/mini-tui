import { describe, expect, test } from "bun:test";

import { defaultDoctorModel, formatDoctor, runDoctor, type DoctorReport } from "../src/cliproxyDoctor";
import { MODELS } from "../src/models";

const green: DoctorReport = {
  base: "http://127.0.0.1:8317/v1",
  model: "cliproxy/claude-opus-5-5",
  ok: true,
  stages: [
    { name: "gateway listening", ok: true, detail: "accepts connections" },
    { name: "api key accepted", ok: true, detail: "HTTP 200" },
    { name: "model advertised", ok: true, detail: "claude-opus-5-5 is in /v1/models" },
    { name: "run works (mini test-model)", ok: true, detail: "answered a one-word completion" },
  ],
};

describe("runDoctor", () => {
  test("a green run reports every stage and exits ok", async () => {
    const report = await runDoctor("cliproxy/claude-opus-5-5", { runTestModel: async () => 0, env: {} });
    expect(report.ok).toBe(true);
    expect(report.stages.map((s) => s.name)).toContain("run works (mini test-model)");
  });

  test("a failing completion fails the report even when the port answers", async () => {
    const report = await runDoctor("cliproxy/claude-opus-5-5", { runTestModel: async () => 1, env: {} });
    expect(report.ok).toBe(false);
    expect(report.stages.at(-1)?.ok).toBe(false);
  });

  test("a helper that returns an odd code is a failure, not a crash", async () => {
    const report = await runDoctor("cliproxy/claude-opus-5-5", { runTestModel: async () => 124 });
    expect(report.ok).toBe(false);
    expect(report.stages.at(-1)?.detail).toContain("124");
  });

  test("the default model comes from the cliproxy/ catalog", () => {
    expect(MODELS.some((o) => String(o.value) === defaultDoctorModel())).toBe(true);
    expect(defaultDoctorModel()).toMatch(/^cliproxy\//);
  });
});

describe("formatDoctor", () => {
  test("a green report says the model is ready", () => {
    const text = formatDoctor(green);
    expect(text).toContain("PASS  gateway listening");
    expect(text).toContain("cliproxy/claude-opus-5-5 is ready to run");
    expect(text).not.toContain("FAIL");
  });

  test("a broken report names the fix under the failing stage", () => {
    const text = formatDoctor({
      ...green,
      ok: false,
      stages: [
        { name: "gateway listening", ok: true, detail: "accepts connections" },
        { name: "api key accepted", ok: false, detail: "HTTP 401: Invalid API key", fix: "set CLIPROXY_API_KEY" },
      ],
    });
    expect(text).toContain("FAIL  api key accepted");
    expect(text).toContain("fix: set CLIPROXY_API_KEY");
    expect(text).toContain("broken at the first FAIL above");
  });
});
