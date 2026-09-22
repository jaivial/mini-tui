import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { App } from "../src/ui/App";
import { parseTrajectory } from "../src/traj/parse";
import type { RunEvent, Trajectory } from "../src/traj/schema";

function loadFixture(name: string): Trajectory {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Trajectory;
}

describe("App rendering", () => {
  test("renders the tool call, its output and the exit banner", async () => {
    const { events, info } = parseTrajectory(loadFixture("normal-step"));
    const setup = await testRender(<App cwd="." events={events} info={info} onQuit={() => {}} />, {
      width: 120,
      height: 60,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("echo TUI_OK"); // the command
    expect(frame).toContain("rc=0"); // the returncode badge
    expect(frame).toContain("TUI_OK"); // the output
    expect(frame).toContain("Submitted"); // the exit banner
    setup.renderer.destroy();
  });

  test("collapses huge outputs with a hidden-lines marker", async () => {
    const events: RunEvent[] = [
      { type: "tool_call", id: "call_x", name: "bash", command: "seq 1 400" },
      {
        type: "observation",
        toolCallId: "call_x",
        returncode: 0,
        output: Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n"),
        exceptionInfo: "",
      },
    ];
    const setup = await testRender(<App cwd="." events={events} info={{ cost: 0, apiCalls: 1 }} onQuit={() => {}} />, {
      width: 120,
      height: 60,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("lines hidden");
    expect(frame).toContain("[e] expand");
    setup.renderer.destroy();
  });

  test("shows error badges and exception info", async () => {
    const { events, info } = parseTrajectory(loadFixture("error-obs"));
    const setup = await testRender(<App cwd="." events={events} info={info} onQuit={() => {}} />, {
      width: 120,
      height: 40,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("rc=2");
    expect(frame).toContain("timed out");
    setup.renderer.destroy();
  });

  test("keyboard: pageup scrolls up and g jumps to the top", async () => {
    const events: RunEvent[] = [];
    for (let i = 1; i <= 8; i++) {
      events.push({ type: "tool_call", id: `call_${i}`, name: "bash", command: `echo CARD-${i}` });
      events.push({ type: "observation", toolCallId: `call_${i}`, returncode: 0, output: `CARD-${i} done`, exceptionInfo: "" });
    }
    const setup = await testRender(<App cwd="." events={events} info={{ cost: 0, apiCalls: 8 }} onQuit={() => {}} />, {
      width: 80,
      height: 16,
    });
    await setup.renderOnce();
    // sticky to bottom on first paint
    expect(setup.captureCharFrame()).toContain("CARD-8");

    setup.mockInput.pressKey(String.fromCharCode(27) + "[5~"); // PageUp
    await setup.renderOnce();
    const afterPageUp = setup.captureCharFrame();
    expect(afterPageUp).toContain("CARD-6");
    expect(afterPageUp).not.toContain("CARD-8");

    setup.mockInput.pressKey("g");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("bash #1");
    setup.renderer.destroy();
  });

  test("/model opens the model picker and switching posts a notice", async () => {
    const { events, info } = parseTrajectory(loadFixture("normal-step"));
    const setup = await testRender(<App cwd="." events={events} info={info} onQuit={() => {}} />, {
      width: 110,
      height: 40,
    });
    await setup.renderOnce();

    // One act() per keystroke, mirroring how keys arrive in a real terminal.
    for (const ch of "/model") {
      await act(async () => {
        setup.mockInput.pressKey(ch);
      });
      await setup.renderOnce();
    }
    expect(setup.captureCharFrame()).toContain("/model▏"); // command buffer in the status bar

    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    const pickerFrame = setup.captureCharFrame();
    expect(pickerFrame).toContain("/model"); // picker title
    expect(pickerFrame).toContain("xiaomi/mimo-v2.6-pro");
    expect(pickerFrame).toContain("DeepSeek flash");

    await act(async () => {
      setup.mockInput.pressEnter(); // pick the highlighted model
    });
    await setup.renderOnce();
    const afterPick = setup.captureCharFrame();
    expect(afterPick).toContain("model →"); // switch notice in the transcript
    setup.renderer.destroy();
  });
});
