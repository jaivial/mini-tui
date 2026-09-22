/**
 * Screenshot scene capture. Runs under `bun test` (testRender needs the test runner):
 *
 *   MINITUI_CAPTURE=1 bun test scripts/capture-scenes.test.tsx
 *   python3 scripts/render-screenshots.py     # JSON spans -> docs/screenshots/*.png
 *
 * Skipped on a normal `bun test` run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { App } from "../src/ui/App";
import type { RunEvent } from "../src/traj/schema";

const OUT_DIR = join(import.meta.dir, "..", "docs", "screenshots");
const CAPTURE = Boolean(process.env.MINITUI_CAPTURE);

interface SpanDump {
  text: string;
  fg: string | null;
  bg: string | null;
}

function hex(buffer: Uint16Array | undefined): string | null {
  if (!buffer || buffer.length < 3) return null;
  const part = (v: number) => Math.min(255, Math.round(v > 255 ? v / 257 : v)).toString(16).padStart(2, "0");
  return `#${part(buffer[0] ?? 0)}${part(buffer[1] ?? 0)}${part(buffer[2] ?? 0)}`;
}

const TASK = "Fix the failing test in `tests/test_utils.py` and make the suite pass.";

const BASE_EVENTS: RunEvent[] = [
  { type: "task", text: TASK },
  {
    type: "assistant",
    text: "Reproducing the failure first:",
  },
  { type: "tool_call", id: "call_1", name: "bash", command: "pytest tests/test_utils.py -x" },
  {
    type: "observation",
    toolCallId: "call_1",
    returncode: 1,
    output:
      "============================= test session starts ==============================\ncollected 3 items\n\ntests/test_utils.py ..F                                                     [100%]\n\n=================================== FAILURES ===================================\n________________________________ test_round_trip _________________________________\nE   AssertionError: assert 0.1 + 0.2 == 0.3\n========================== 1 failed, 2 passed in 0.04s ==========================",
    exceptionInfo: "",
  },
  {
    type: "assistant",
    text: "Float precision. Comparing with a tolerance:",
  },
  {
    type: "tool_call",
    id: "call_2",
    name: "bash",
    command: "sed -i 's/== 0.3/== pytest.approx(0.3)/' tests/test_utils.py",
  },
  { type: "observation", toolCallId: "call_2", returncode: 0, output: "", exceptionInfo: "" },
  { type: "notice", text: "model → xiaomi/mimo-v2.6-pro (from next step)", interruptType: "model" },
  {
    type: "assistant",
    text: "Re-running the suite:",
  },
  { type: "tool_call", id: "call_3", name: "bash", command: "pytest tests/ -q" },
  {
    type: "observation",
    toolCallId: "call_3",
    returncode: 0,
    output: "........                                                                 [100%]\n8 passed in 0.12s",
    exceptionInfo: "",
  },
];

const FINAL_EVENTS: RunEvent[] = [
  { type: "task", text: TASK },
  { type: "tool_call", id: "call_1", name: "bash", command: "pytest tests/ -q" },
  {
    type: "observation",
    toolCallId: "call_1",
    returncode: 0,
    output: "........                                                                 [100%]\n8 passed in 0.12s",
    exceptionInfo: "",
  },
  {
    type: "assistant",
    text: "The failure was a float comparison without tolerance in `test_round_trip`.\nI replaced `== 0.3` with `== pytest.approx(0.3)` in `tests/test_utils.py` and\nthe whole suite passes now: **8 passed in 0.12s**.",
  },
  {
    type: "exit",
    exitStatus: "Submitted",
    submission:
      "The failure was a float comparison without tolerance in `test_round_trip`.\nI replaced `== 0.3` with `== pytest.approx(0.3)` and the suite passes: 8 passed.",
  },
];

test.skipIf(!CAPTURE)("capture screenshot scenes", async () => {
  mkdirSync(OUT_DIR, { recursive: true });
  const info = { model: "xiaomi/mimo-v2.6-flash", cost: 0.0217, apiCalls: 3 };

  const save = (name: string, setup: Awaited<ReturnType<typeof testRender>>) => {
    const frame = setup.captureSpans();
    const lines: SpanDump[][] = frame.lines.map((line) =>
      line.spans.map((span) => ({ text: span.text, fg: hex(span.fg?.buffer), bg: hex(span.bg?.buffer) })),
    );
    writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify({ cols: frame.cols, rows: frame.rows, lines }, null, 1));
    setup.renderer.destroy();
  };

  // 1) live run transcript
  let setup = await testRender(<App cwd="." events={BASE_EVENTS} info={info} statusOverride="running" onQuit={() => {}} />, {
    width: 110,
    height: 38,
  });
  await setup.renderOnce();
  save("run", setup);

  // 2) /model picker
  setup = await testRender(<App cwd="." events={BASE_EVENTS} info={info} statusOverride="running" onQuit={() => {}} />, {
    width: 110,
    height: 38,
  });
  await setup.renderOnce();
  for (const ch of "/model") {
    await act(async () => {
      setup.mockInput.pressKey(ch);
    });
    await setup.renderOnce();
  }
  await act(async () => {
    setup.mockInput.pressEnter();
  });
  await setup.renderOnce();
  save("model-picker", setup);

  // 3) plain-text final answer + exit banner
  setup = await testRender(<App cwd="." events={FINAL_EVENTS} info={{ ...info, apiCalls: 2 }} onQuit={() => {}} />, {
    width: 110,
    height: 38,
  });
  await setup.renderOnce();
  save("final-answer", setup);

  // 4) start screen
  setup = await testRender(<App cwd="/home/jaime/project" onQuit={() => {}} />, { width: 110, height: 24 });
  await setup.renderOnce();
  save("start", setup);
});
