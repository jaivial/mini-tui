import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { App } from "../src/ui/App";
import { CommandPalette, buildOptions } from "../src/ui/components/CommandPalette";
import { MODELS } from "../src/ui/components/ModelPicker";
import { parseTrajectory } from "../src/traj/parse";
import { createSession, openDb, saveTranscript } from "../src/sessions";
import type { RunEvent, Trajectory } from "../src/traj/schema";

const EXPANDED = { outputMode: "expanded" as const };

function loadFixture(name: string): Trajectory {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Trajectory;
}

describe("App rendering", () => {
  test("renders tool call and output (and skips the redundant Submitted exit)", async () => {
    const { events, info } = parseTrajectory(loadFixture("normal-step"));
    const setup = await testRender(
      <App cwd="." events={events} info={info} initialSettings={EXPANDED} onQuit={() => {}} />,
      { width: 120, height: 60 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("echo TUI_OK"); // the command
    expect(frame).toContain("rc=0"); // the returncode badge
    expect(frame).toContain("TUI_OK"); // the output
    expect(frame).not.toContain("Submitted"); // redundant with the final answer above
    expect(frame).not.toContain("Echoed and submitted."); // no duplicate exit text
    setup.renderer.destroy();
  });

  test("collapsed mode shows only a tool-call count line", async () => {
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
    const setup = await testRender(
      <App
        cwd="."
        events={events}
        info={{ cost: 0, apiCalls: 1 }}
        initialSettings={{ outputMode: "collapsed" }}
        persistSettings={false}
        onQuit={() => {}}
      />,
      { width: 120, height: 30 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("1 tool call");
    expect(frame).toContain("[e] expand");
    expect(frame).not.toContain("line 21");
    expect(frame).not.toContain("seq 1 400");
    setup.renderer.destroy();
  });

  test("shows error badges and exception info", async () => {
    const { events, info } = parseTrajectory(loadFixture("error-obs"));
    const setup = await testRender(
      <App cwd="." events={events} info={info} initialSettings={EXPANDED} onQuit={() => {}} />,
      { width: 120, height: 40 },
    );
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
    const setup = await testRender(
      <App cwd="." events={events} info={{ cost: 0, apiCalls: 8 }} initialSettings={EXPANDED} onQuit={() => {}} />,
      { width: 80, height: 16 },
    );
    await setup.renderOnce();
    await Bun.sleep(20); // the follow-the-bottom toggle settles after the first paint
    await setup.renderOnce();
    // sticky to bottom once the content is taller than the viewport
    expect(setup.captureCharFrame()).toContain("CARD-8");

    setup.mockInput.pressEscape(); // leave the prompt input (normal mode)
    await Bun.sleep(60); // bare ESC is only emitted after the key parser's sequence timeout
    setup.mockInput.pressKey(String.fromCharCode(27) + "[5~"); // PageUp
    await setup.renderOnce();
    const afterPageUp = setup.captureCharFrame();
    expect(afterPageUp).toContain("bash #5"); // the view moved up several steps
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
    const setup = await testRender(<App cwd="." events={events} info={info} initialSettings={EXPANDED} onQuit={() => {}} />, {
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
    expect(setup.captureCharFrame()).toContain("settings · Tab switches group");
    setup.renderer.destroy();
  });

  test("$ palette lists ~/.claude/skills and sends the skill instructions with the request", async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), "mini-tui-skills-ui-"));
    mkdirSync(join(skillsDir, "good-code"));
    writeFileSync(join(skillsDir, "good-code", "SKILL.md"), "---\ndescription: minimum code needed\n---\nKEEP-IT-SMALL\n");
    const sent: string[] = [];
    const setup = await testRender(
      <App cwd="." events={[]} info={{ cost: 0, apiCalls: 0 }} skillsDir={skillsDir} onSend={(text) => sent.push(text)} onQuit={() => {}} />,
      { width: 100, height: 24 },
    );
    await setup.renderOnce();
    await setup.mockInput.typeText("$go");
    await Bun.sleep(20);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("minimum code needed"); // skill row in the palette

    await act(async () => {
      setup.mockInput.pressEnter(); // fill `$good-code `, never sends
    });
    expect(sent).toEqual([]);
    await setup.mockInput.typeText("tidy up");
    await Bun.sleep(20);
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("KEEP-IT-SMALL");
    expect(sent[0]!.endsWith("tidy up")).toBe(true);

    setup.renderer.destroy();
    rmSync(skillsDir, { recursive: true, force: true });
  });

  test("settings: /settings opens the output display panel", async () => {
    const { events, info } = parseTrajectory(loadFixture("normal-step"));
    const setup = await testRender(
      <App cwd="." events={events} info={info} initialSettings={EXPANDED} persistSettings={false} onQuit={() => {}} />,
      { width: 110, height: 30 },
    );
    await setup.renderOnce();

    await setup.mockInput.typeText("/settings");
    await Bun.sleep(20);
    await act(async () => {
      setup.mockInput.pressEnter(); // fill
    });
    await setup.renderOnce();
    await act(async () => {
      setup.mockInput.pressEnter(); // run
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("settings · Tab switches group");
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
      <App cwd="." events={events} info={{ cost: 0, apiCalls: 1 }} initialSettings={EXPANDED} onQuit={() => {}} />,
      { width: 90, height: 60 },
    );
    await full.renderOnce();
    const fullFrame = full.captureCharFrame();
    expect(fullFrame).toContain("line 1");
    expect(fullFrame).toContain("line 40");
    expect(fullFrame).not.toContain("lines hidden");
    full.renderer.destroy();
  });

  test("meta row shows model, path and git branch", async () => {
    const setup = await testRender(
      <App
        cwd="/home/jaime/mini-tui"
        events={[]}
        info={{ cost: 0, apiCalls: 0, model: "xiaomi/mimo-v2.6-flash" }}
        onQuit={() => {}}
      />,
      { width: 100, height: 16 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("xiaomi/mimo-v2.6-flash");
    expect(frame).toContain("mini-tui");
    expect(frame).toContain("⎇ main");
    setup.renderer.destroy();
  });

  test("/help opens the help panel", async () => {
    const setup = await testRender(
      <App cwd="." events={[]} info={{ cost: 0, apiCalls: 0 }} onQuit={() => {}} />,
      { width: 100, height: 26 },
    );
    await setup.renderOnce();
    await setup.mockInput.typeText("/help");
    await Bun.sleep(20);
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("help · Esc close");
    expect(frame).toContain("/quit  ·  /exit");
    expect(frame).toContain("double Esc interrupts the run");
    setup.renderer.destroy();
  });

  test("/quit closes the TUI (fill does not, run does)", async () => {
    let quits = 0;
    const setup = await testRender(
      <App cwd="." events={[]} info={{ cost: 0, apiCalls: 0 }} onQuit={() => (quits += 1)} />,
      { width: 80, height: 16 },
    );
    await setup.renderOnce();
    await setup.mockInput.typeText("/quit");
    await Bun.sleep(20);
    await act(async () => {
      setup.mockInput.pressEnter(); // palette fill
    });
    await setup.renderOnce();
    expect(quits).toBe(0);
    await act(async () => {
      setup.mockInput.pressEnter(); // execute
    });
    await setup.renderOnce();
    expect(quits).toBe(1);
    setup.renderer.destroy();
  });

  test("↑/↓ in the prompt recall the prompts sent in this session", async () => {
    const sent: string[] = [];
    const setup = await testRender(
      <App cwd="." events={[]} info={{ cost: 0, apiCalls: 0 }} onSend={(text) => sent.push(text)} onQuit={() => {}} />,
      { width: 80, height: 16 },
    );
    await setup.renderOnce();
    for (const text of ["first task", "/help", "second task"]) {
      await setup.mockInput.typeText(text);
      await Bun.sleep(20);
      await act(async () => {
        setup.mockInput.pressEnter(); // "/help" fills from the palette first
      });
      if (text === "/help") {
        await act(async () => {
          setup.mockInput.pressEnter();
        });
        setup.mockInput.pressEscape(); // close the help panel
        await Bun.sleep(60);
      }
    }
    expect(sent).toEqual(["first task", "second task"]);
    await setup.mockInput.typeText("draft");
    await Bun.sleep(20);
    const prompt = async () => {
      await Bun.sleep(20);
      await setup.renderOnce();
      return setup.captureCharFrame().split("\n").slice(-6).join("\n"); // the bottom stack
    };
    await act(async () => setup.mockInput.pressArrow("up"));
    expect(await prompt()).toContain("second task");
    await act(async () => setup.mockInput.pressArrow("up"));
    expect(await prompt()).toContain("/help");
    await act(async () => setup.mockInput.pressArrow("up")); // palette stays closed → keeps browsing
    expect(await prompt()).toContain("first task");
    await act(async () => setup.mockInput.pressArrow("down"));
    await act(async () => setup.mockInput.pressArrow("down"));
    await act(async () => setup.mockInput.pressArrow("down"));
    expect(await prompt()).toContain("draft"); // the half-written draft comes back
    await act(async () => setup.mockInput.pressEnter());
    expect(sent).toEqual(["first task", "second task", "draft"]);
    setup.renderer.destroy();
  });

  test("/new clears the transcript and the prompt history in place", async () => {
    let quits = 0;
    const events: RunEvent[] = [
      { type: "task", text: "OLD-TASK" },
      { type: "tool_call", id: "c1", name: "bash", command: "echo OLD-OUTPUT" },
      { type: "observation", toolCallId: "c1", returncode: 0, output: "OLD-OUTPUT", exceptionInfo: "" },
    ];
    const setup = await testRender(
      <App cwd="." events={events} info={{ cost: 0.5, apiCalls: 1 }} initialSettings={EXPANDED} persistSettings={false} onSend={() => {}} onQuit={() => (quits += 1)} />,
      { width: 90, height: 20 },
    );
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("OLD-TASK");

    await setup.mockInput.typeText("remember me");
    await Bun.sleep(20);
    await act(async () => setup.mockInput.pressEnter());
    await setup.mockInput.typeText("/new");
    await Bun.sleep(20);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("start a new session"); // palette entry
    await act(async () => setup.mockInput.pressEnter()); // fill
    await act(async () => setup.mockInput.pressEnter()); // run
    await Bun.sleep(20);
    await setup.renderOnce();
    let frame = setup.captureCharFrame();
    expect(quits).toBe(0);
    expect(frame).not.toContain("OLD-TASK");
    expect(frame).not.toContain("OLD-OUTPUT");
    expect(frame).toContain("new session");

    await act(async () => setup.mockInput.pressArrow("up")); // history starts empty again
    await Bun.sleep(20);
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    expect(frame).not.toContain("remember me");
    setup.renderer.destroy();
  });

  test("ctrl+c once clears the prompt, twice closes (also from navigation mode)", async () => {
    let quits = 0;
    const setup = await testRender(
      <App cwd="." events={[]} info={{ cost: 0, apiCalls: 0 }} onQuit={() => (quits += 1)} />,
      { width: 80, height: 16, exitOnCtrlC: false }, // like src/index.ts
    );
    await setup.renderOnce();
    await setup.mockInput.typeText("draft prompt");
    await Bun.sleep(20);
    await act(async () => {
      setup.mockInput.pressCtrlC();
    });
    await setup.renderOnce();
    let frame = setup.captureCharFrame();
    expect(quits).toBe(0);
    expect(frame).not.toContain("draft prompt"); // cleared
    expect(frame).toContain("ctrl+c again to close");

    await act(async () => {
      setup.mockInput.pressCtrlC();
    });
    expect(quits).toBe(1);
    setup.renderer.destroy();

    // an empty prompt still needs two presses; a stale first press does not count
    let quits2 = 0;
    const other = await testRender(
      <App cwd="." events={[]} info={{ cost: 0, apiCalls: 0 }} onQuit={() => (quits2 += 1)} />,
      { width: 80, height: 16, exitOnCtrlC: false }, // like src/index.ts
    );
    await other.renderOnce();
    other.mockInput.pressEscape(); // navigation mode
    await Bun.sleep(60);
    await act(async () => {
      other.mockInput.pressCtrlC();
    });
    expect(quits2).toBe(0);
    await Bun.sleep(1600); // past the double-press window
    await act(async () => {
      other.mockInput.pressCtrlC();
    });
    expect(quits2).toBe(0);
    await act(async () => {
      other.mockInput.pressCtrlC();
    });
    expect(quits2).toBe(1);
    other.renderer.destroy();
  });

  test("double Esc interrupts the run and never quits the TUI", async () => {
    let quits = 0;
    let interrupts = 0;
    const setup = await testRender(
      <App
        cwd="."
        events={[]}
        info={{ cost: 0, apiCalls: 0 }}
        statusOverride="running"
        onInterrupt={() => (interrupts += 1)}
        onQuit={() => (quits += 1)}
      />,
      { width: 90, height: 18 },
    );
    await setup.renderOnce();
    setup.mockInput.pressEscape();
    await Bun.sleep(100); // inside the double-press window (and past the ESC parser timeout)
    setup.mockInput.pressEscape();
    await Bun.sleep(100); // the second bare ESC is only emitted after the parser timeout
    await setup.renderOnce();
    expect(interrupts).toBe(1);
    expect(quits).toBe(0); // quitting stays on /quit, /exit and double ctrl+c
    expect(setup.captureCharFrame()).toContain("interrupt");
    setup.renderer.destroy();
  });
});

describe("markdown and palette extras", () => {
  test("final answer renders as markdown (no literal ** or ` markers)", async () => {
    const events: RunEvent[] = [
      { type: "task", text: "Summarize the fix" },
      {
        type: "assistant",
        text: "**Fixed:** use `pytest.approx(0.3)` instead of `== 0.3` — **8 passed**.",
      },
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
    expect(frame).not.toContain("Submitted"); // duplicate exit card is gone
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

describe("bottom stack", () => {
  test("one status line under the prompt: loader · model · path · branch · step · cost", async () => {
    const running = await testRender(
      <App
        cwd="/home/jaime/mini-tui"
        events={[]}
        info={{ cost: 0.0217, apiCalls: 3, model: "xiaomi/mimo-v2.6-pro" }}
        statusOverride="running"
        onQuit={() => {}}
      />,
      { width: 120, height: 18 },
    );
    await running.renderOnce();
    const runFrame = running.captureCharFrame();
    const lines = runFrame.split("\n").map((l) => l.trimEnd());
    const boxTop = lines.findIndex((l) => l.startsWith("╭"));
    const boxBottom = lines.findIndex((l) => l.startsWith("╰") && lines.indexOf(l) > boxTop);
    expect(boxBottom - boxTop).toBe(2); // prompt box: 3 rows, no empty gap

    // everything lives on the single line right below the prompt
    const statusIdx = boxBottom + 1;
    const statusLine = lines[statusIdx];
    expect(statusLine).toContain("working ·");
    expect(statusLine).toContain("xiaomi/mimo-v2.6-pro");
    expect(statusLine).toContain("mini-tui");
    expect(statusLine).toContain("⎇ main");
    // no step/cost noise on the line
    expect(statusLine).not.toContain("step");
    expect(statusLine).not.toContain("$");
    running.renderer.destroy();

    const done = await testRender(
      <App cwd="." events={[]} info={{ cost: 0, apiCalls: 0 }} statusOverride="done" onQuit={() => {}} />,
      { width: 120, height: 18 },
    );
    await done.renderOnce();
    const doneFrame = done.captureCharFrame();
    expect(doneFrame).not.toContain("working ·");
    expect(doneFrame).toContain("● done");
    done.renderer.destroy();
  });

  test("opening the TUI shows no load state until a run starts", async () => {
    const setup = await testRender(<App cwd="/home/jaime/mini-tui" onQuit={() => {}} />, { width: 120, height: 18 });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("what should mini do"); // prompt ready
    expect(frame).not.toContain("working ·"); // no loader while idle
    expect(frame).not.toContain("●"); // no status chip while idle
    expect(frame).not.toContain("step"); // no stats on the line
    setup.renderer.destroy();
  });
});

describe("theme selector", () => {
  test("switching theme from the settings panel applies it live", async () => {
    const setup = await testRender(
      <App cwd="/proj" persistSettings={false} initialSettings={{ outputMode: "expanded", theme: "shadcn" }} onQuit={() => {}} />,
      { width: 110, height: 34 },
    );
    await setup.renderOnce();
    await setup.mockInput.typeText("/settings");
    await Bun.sleep(20);
    await act(async () => {
      setup.mockInput.pressEnter(); // palette fill
    });
    await setup.renderOnce();
    await act(async () => {
      setup.mockInput.pressEnter(); // open the panel
    });
    await setup.renderOnce();
    let frame = setup.captureCharFrame();
    expect(frame).toContain("theme");
    expect(frame).toContain("catppuccin");
    expect(frame).toContain("tokyo night");

    await act(async () => {
      setup.mockInput.pressTab(); // move to the theme group
    });
    await setup.renderOnce();
    await act(async () => {
      setup.mockInput.pressKey(String.fromCharCode(27) + "[B"); // ↓ → nord
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("theme → nord");
    setup.renderer.destroy();
  });
});

describe("select-to-copy", () => {
  test("highlighting text with the mouse copies it", async () => {
    const copied: string[] = [];
    const { events, info } = parseTrajectory(loadFixture("normal-step"));
    const setup = await testRender(
      <App
        cwd="."
        events={events}
        info={info}
        initialSettings={EXPANDED}
        onCopy={(text) => copied.push(text)}
        onQuit={() => {}}
      />,
      { width: 120, height: 60 },
    );
    await setup.renderOnce();

    // drag across the command row of the first card
    await setup.mockMouse.pressDown(2, 5);
    await setup.mockMouse.moveTo(20, 5);
    await setup.mockMouse.release(20, 5);
    await Bun.sleep(500); // the copy happens once the selection settles

    expect(copied.length).toBe(1);
    expect(copied[0].length).toBeGreaterThan(0);
    expect(setup.captureCharFrame()).toContain("copied");
    expect(setup.captureCharFrame()).toContain("→ clipboard");
    setup.renderer.destroy();
  });
});

describe("e toggles any block", () => {
  const events: RunEvent[] = [
    { type: "tool_call", id: "call_x", name: "bash", command: "seq 1 30" },
    {
      type: "observation",
      toolCallId: "call_x",
      returncode: 0,
      output: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"),
      exceptionInfo: "",
    },
  ];

  test("collapses blocks in trim/expanded modes and expands them in collapsed", async () => {
    for (const mode of ["trim", "expanded"] as const) {
      const setup = await testRender(
        <App cwd="." events={events} info={{ cost: 0, apiCalls: 1 }} initialSettings={{ outputMode: mode }} onQuit={() => {}} />,
        { width: 90, height: 30 },
      );
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("line 1"); // full view by default

      setup.mockInput.pressEscape();
      await Bun.sleep(60); // navigate mode (bare ESC needs the parser timeout)
      setup.mockInput.pressKey("e"); // collapse the focused block
      await Bun.sleep(20);
      await setup.renderOnce();
      let frame = setup.captureCharFrame();
      expect(frame).toContain("1 tool call");
      expect(frame).not.toContain("line 1");

      setup.mockInput.pressKey("e"); // expand it again
      await Bun.sleep(20);
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      expect(frame).toContain("line 1");
      expect(frame).toContain("[e] collapse");
      setup.renderer.destroy();
    }
  });

  test("expands blocks in collapsed mode", async () => {
    const setup = await testRender(
      <App
        cwd="."
        events={events}
        info={{ cost: 0, apiCalls: 1 }}
        initialSettings={{ outputMode: "collapsed" }}
        onQuit={() => {}}
      />,
      { width: 90, height: 30 },
    );
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("1 tool call");

    setup.mockInput.pressEscape();
    await Bun.sleep(60);
    setup.mockInput.pressKey("e");
    await Bun.sleep(20);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("line 1"); // flipped open reveals the output
    expect(frame).toContain("seq 1 30"); // command shown too
    expect(frame).not.toContain("1 tool call");
    setup.renderer.destroy();
  });

  test("mouse click on a block toggles it too", async () => {
    const setup = await testRender(
      <App
        cwd="."
        events={events}
        info={{ cost: 0, apiCalls: 1 }}
        initialSettings={{ outputMode: "collapsed" }}
        onQuit={() => {}}
      />,
      { width: 90, height: 30 },
    );
    await setup.renderOnce();
    await setup.mockMouse.click(20, 0); // the count line (first content row)
    await Bun.sleep(20);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("seq 1 30"); // flipped open on click
    expect(frame).not.toContain("1 tool call");
    setup.renderer.destroy();
  });
});
