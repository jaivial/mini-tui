import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { App } from "../src/ui/App";
import { CommandPalette, buildOptions } from "../src/ui/components/CommandPalette";
import { MODELS } from "../src/ui/components/ModelPicker";
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

  test("keyboard: Esc leaves the prompt, pageup scrolls up and g jumps to the top", async () => {
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

    setup.mockInput.pressEscape(); // leave the prompt input (normal mode)
    await Bun.sleep(60); // bare ESC is only emitted after the key parser's sequence timeout
    setup.mockInput.pressKey(String.fromCharCode(27) + "[5~"); // PageUp
    await setup.renderOnce();
    const afterPageUp = setup.captureCharFrame();
    expect(afterPageUp).toContain("bash #6"); // the view moved up over earlier steps
    expect(afterPageUp).not.toContain("CARD-8");

    setup.mockInput.pressKey("g");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("bash #1");
    setup.renderer.destroy();
  });

  test("prompt: multi-line text is sent on Enter", async () => {
    const sent: string[] = [];
    const setup = await testRender(
      <App cwd="." events={[]} info={{ cost: 0, apiCalls: 0 }} onSend={(text) => sent.push(text)} onQuit={() => {}} />,
      { width: 90, height: 16 },
    );
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("what should mini do"); // the prompt bar is always there

    await setup.mockInput.typeText("line one\nline two"); // \n inserts a newline (Ctrl+J semantics)
    await act(async () => {
      setup.mockInput.pressEnter(); // send
    });
    await setup.renderOnce();
    expect(sent).toEqual(["line one\nline two"]);
    setup.renderer.destroy();
  });

  test("/model typed in the prompt opens the model picker and switching posts a notice", async () => {
    const { events, info } = parseTrajectory(loadFixture("normal-step"));
    const setup = await testRender(<App cwd="." events={events} info={info} onQuit={() => {}} />, {
      width: 110,
      height: 40,
    });
    await setup.renderOnce();

    await setup.mockInput.typeText("/model");
    await Bun.sleep(20); // palette query syncs right after the key batch
    await act(async () => {
      setup.mockInput.pressEnter(); // complete into the prompt (does not send)
    });
    await setup.renderOnce();
    await act(async () => {
      setup.mockInput.pressEnter(); // now send the command
    });
    await setup.renderOnce();
    const pickerFrame = setup.captureCharFrame();
    expect(pickerFrame).toContain("Xiaomi MiMo V2.6 Pro"); // picker is open
    expect(pickerFrame).toContain("DeepSeek flash");

    await act(async () => {
      setup.mockInput.pressEnter(); // pick the highlighted model
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("model →"); // switch notice in the transcript
    setup.renderer.destroy();
  });

  test("slash palette: real-time filter and fill without sending", async () => {
    const sent: string[] = [];
    const setup = await testRender(
      <App cwd="." events={[]} info={{ cost: 0, apiCalls: 0 }} onSend={(text) => sent.push(text)} onQuit={() => {}} />,
      { width: 100, height: 30 },
    );
    await setup.renderOnce();

    await setup.mockInput.typeText("/");
    await Bun.sleep(20);
    await setup.renderOnce();
    let frame = setup.captureCharFrame();
    expect(frame).toContain("open the model picker"); // palette is open with all commands
    expect(frame).toContain("output display settings");

    await setup.mockInput.typeText("set");
    await Bun.sleep(20);
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    expect(frame).toContain("/settings");
    expect(frame).not.toContain("gpt-6-astra"); // filtered out

    await act(async () => {
      setup.mockInput.pressEnter(); // select → fills the prompt
    });
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    expect(sent).toEqual([]); // selection must NOT send
    expect(frame).not.toContain("output display settings"); // palette closed
    expect(frame).toContain("/settings"); // filled into the prompt

    await act(async () => {
      setup.mockInput.pressEnter(); // now it runs the command
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("settings · output display");
    setup.renderer.destroy();
  });

  test("settings: /settings opens the output display panel", async () => {
    const { events, info } = parseTrajectory(loadFixture("normal-step"));
    const setup = await testRender(<App cwd="." events={events} info={info} onQuit={() => {}} />, {
      width: 110,
      height: 30,
    });
    await setup.renderOnce();

    await setup.mockInput.typeText("/settings");
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("settings · output display");
    expect(frame).toContain("collapsed");
    expect(frame).toContain("trimmed (2 lines)");
    expect(frame).toContain("expanded");

    await act(async () => {
      setup.mockInput.pressEnter(); // apply the highlighted mode
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("output display →");
    setup.renderer.destroy();
  });

  test("output modes: trimmed shows 2 lines, expanded shows everything", async () => {
    const events: RunEvent[] = [
      { type: "tool_call", id: "call_x", name: "bash", command: "seq 1 40" },
      {
        type: "observation",
        toolCallId: "call_x",
        returncode: 0,
        output: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"),
        exceptionInfo: "",
      },
    ];

    const trimmed = await testRender(
      <App cwd="." events={events} info={{ cost: 0, apiCalls: 1 }} initialSettings={{ outputMode: "trim" }} onQuit={() => {}} />,
      { width: 90, height: 30 },
    );
    await trimmed.renderOnce();
    const trimFrame = trimmed.captureCharFrame();
    expect(trimFrame).toContain("line 1");
    expect(trimFrame).toContain("line 2");
    expect(trimFrame).not.toContain("line 3");
    expect(trimFrame).toContain("lines hidden");
    trimmed.renderer.destroy();

    const full = await testRender(
      <App
        cwd="."
        events={events}
        info={{ cost: 0, apiCalls: 1 }}
        initialSettings={{ outputMode: "expanded" }}
        onQuit={() => {}}
      />,
      { width: 90, height: 60 },
    );
    await full.renderOnce();
    const fullFrame = full.captureCharFrame();
    expect(fullFrame).toContain("line 1");
    expect(fullFrame).toContain("line 40");
    expect(fullFrame).not.toContain("lines hidden");
    full.renderer.destroy();
  });
});

describe("markdown and palette extras", () => {
  test("final answer renders as markdown (no literal ** or ` markers)", async () => {
    const events: RunEvent[] = [
      { type: "task", text: "Summarize the fix" },
      {
        type: "exit",
        exitStatus: "Submitted",
        submission: "**Fixed:** use `pytest.approx(0.3)` instead of `== 0.3` — **8 passed**.",
      },
    ];
    const setup = await testRender(<App cwd="." events={events} info={{ cost: 0, apiCalls: 1 }} onQuit={() => {}} />, {
      width: 100,
      height: 24,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Fixed:");
    expect(frame).toContain("8 passed");
    expect(frame).not.toContain("**");
    expect(frame).not.toContain("`");
    setup.renderer.destroy();
  });

  test("command palette rows respond to a mouse click", async () => {
    const picks: string[] = [];
    const options = buildOptions(MODELS).slice(0, 3);
    const setup = await testRender(
      <CommandPalette options={options} selectedIndex={0} onPick={(option) => picks.push(option.insert)} />,
      { width: 80, height: 10 },
    );
    await setup.renderOnce();
    await setup.mockMouse.click(10, 2); // second row (row 0 is the border)
    await setup.renderOnce();
    expect(picks).toEqual([options[1].insert]);
    setup.renderer.destroy();
  });
});
