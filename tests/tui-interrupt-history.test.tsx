/** Double Esc interrupts from the prompt and leaves focus in it, so ↑ still recalls the last prompt. */
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../src/ui/App";
process.env.MINITUI_CONNECTIONS_PATH = "/dev/null/x.json";
process.env.MINITUI_LAST_MODEL_PATH = "/dev/null/y.json";
test("after double-Esc interrupt, arrow up recalls the last prompt", async () => {
  const sent: string[] = [];
  const setup = await testRender(<App cwd="." events={[]} info={{ cost: 0, apiCalls: 0 }} onSend={(t) => sent.push(t)} onInterrupt={() => {}} onQuit={() => {}} />, { width: 80, height: 16 });
  await setup.renderOnce();
  await setup.mockInput.typeText("first task");
  await Bun.sleep(20);
  await act(async () => setup.mockInput.pressEnter());
  setup.mockInput.pressEscape();
  await Bun.sleep(100);
  setup.mockInput.pressEscape();
  await Bun.sleep(100);
  await act(async () => setup.mockInput.pressArrow("up"));
  await Bun.sleep(30);
  await setup.renderOnce();
  const bottom = setup.captureCharFrame().split("\n").slice(-6).join("\n");
  expect(bottom).toContain("first task");
  setup.renderer.destroy();
});

test("deriveStatus: a note the UI adds (a model switch, a skill warning) never reads as work", async () => {
  const { deriveStatus } = await import("../src/ui/App");
  const done: any[] = [{ type: "task", text: "t" }, { type: "exit", exitStatus: "Submitted", submission: "" }];
  const model = { type: "notice", text: "model -> x (next run)", interruptType: "model" };
  const skill = { type: "notice", text: "unknown skill sent as plain text: $x" };
  expect(deriveStatus("running", [...done, model])).toBe("done");
  expect(deriveStatus("running", [...done, model, skill, model])).toBe("done");
  expect(deriveStatus("running", [...done, model, { type: "task", text: "follow-up" }])).toBe("running"); // real work again
  expect(deriveStatus("interrupted", [...done, model])).toBe("interrupted");
  expect(deriveStatus("running", [...done, { type: "notice", text: "compacted", interruptType: "context" }])).toBe("running"); // the agent's own
});
