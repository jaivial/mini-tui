import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";

process.env.MINITUI_CONNECTIONS_PATH = "/dev/null/mini-tui-no-connections.json";
process.env.MINITUI_LAST_MODEL_PATH = "/dev/null/mini-tui-no-last-model.json";

import { App } from "../src/ui/App";
import { createSession, openDb, saveTranscript } from "../src/sessions";
import { previewBlocks } from "../src/ui/preview";
import type { RunEvent } from "../src/traj/schema";

const EVENTS: RunEvent[] = [
  { type: "task", text: "fix the tax rounding bug" },
  { type: "assistant", text: "Looking at the billing module first." },
  { type: "tool_call", id: "c1", name: "bash", command: "grep -rn round src/billing" },
  { type: "observation", toolCallId: "c1", returncode: 0, output: "src/billing/tax.py:12: round(x)", exceptionInfo: "" },
  { type: "assistant", text: "PREVIEW_FINAL_ANSWER rounding now uses Decimal." },
];

function seed(dbPath: string) {
  const db = openDb(dbPath);
  createSession(db, { id: "s1", cwd: "/proj", model: "xiaomi/mimo-v2.6-pro", task: "fix tax", title: "Fix tax rounding" });
  saveTranscript(db, "s1", EVENTS, { cost: 0.01, apiCalls: 2 }, []);
  createSession(db, { id: "s2", cwd: "/proj", model: "m", task: "empty one", title: "Empty session" });
  db.close();
}

async function openResume(setup: Awaited<ReturnType<typeof testRender>>) {
  await setup.mockInput.typeText("/resume");
  await Bun.sleep(20);
  await act(async () => setup.mockInput.pressEnter());
  await setup.renderOnce();
  await act(async () => setup.mockInput.pressEnter());
  await setup.renderOnce();
}

describe("/resume preview", () => {
  test("previewBlocks pairs tools, clips, and caps long sessions", () => {
    const blocks = previewBlocks(EVENTS);
    expect(blocks.map((b) => b.kind)).toEqual(["task", "assistant", "tool", "assistant"]);
    const many: RunEvent[] = Array.from({ length: 50 }, (_, i) => ({ type: "assistant", text: `m${i}` }));
    const capped = previewBlocks(many, 10);
    expect(capped).toHaveLength(11);
    expect(capped[10]).toMatchObject({ kind: "more" });
    expect(previewBlocks([])).toEqual([]);
  });

  test("→ previews the selected session read-only, ← goes back, Enter opens it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mini-tui-preview-"));
    const dbPath = join(dir, "s.sqlite");
    seed(dbPath);
    const sent: string[] = [];
    const setup = await testRender(<App cwd="/proj" dbPath={dbPath} onSend={(t) => sent.push(t)} onQuit={() => {}} />, { width: 110, height: 34 });
    await setup.renderOnce();
    await openResume(setup);
    let frame = setup.captureCharFrame();
    expect(frame).toContain("→ preview");

    // pick "Fix tax rounding" (the older one — lists are newest first)
    const target = frame.indexOf("Fix tax rounding") < frame.indexOf("Empty session") ? 0 : 1;
    for (let i = 0; i < target; i++) await act(async () => setup.mockInput.pressArrow("down"));
    await act(async () => setup.mockInput.pressArrow("right"));
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    expect(frame).toContain("preview · read-only");
    expect(frame).toContain("fix the tax rounding bug");
    expect(frame).toContain("grep -rn round src/billing");
    expect(frame).toContain("PREVIEW_FINAL_ANSWER");

    // typing while previewing does not edit the search or send anything
    await setup.mockInput.typeText("zz");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("preview · read-only");

    // ← back to the list (search unchanged)
    await act(async () => setup.mockInput.pressArrow("left"));
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    expect(frame).not.toContain("preview · read-only");
    expect(frame).toContain("Empty session");

    // → then Enter opens the session in the main transcript
    await act(async () => setup.mockInput.pressArrow("right"));
    await setup.renderOnce();
    await act(async () => setup.mockInput.pressEnter());
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    expect(frame).not.toContain("preview · read-only");
    expect(frame).not.toContain("resume · sessions");
    expect(frame).toContain("PREVIEW_FINAL_ANSWER");
    expect(sent).toEqual([]);

    // reopening /resume lands on the list, not the old preview
    await openResume(setup);
    expect(setup.captureCharFrame()).toContain("resume · sessions in this folder");
    setup.renderer.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  test("an empty session previews without crashing and Esc returns to the list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mini-tui-preview-"));
    const dbPath = join(dir, "s.sqlite");
    seed(dbPath);
    const setup = await testRender(<App cwd="/proj" dbPath={dbPath} onSend={() => {}} onQuit={() => {}} />, { width: 110, height: 20 });
    await setup.renderOnce();
    await openResume(setup);
    const frame = setup.captureCharFrame();
    const target = frame.indexOf("Empty session") < frame.indexOf("Fix tax rounding") ? 0 : 1;
    for (let i = 0; i < target; i++) await act(async () => setup.mockInput.pressArrow("down"));
    await act(async () => setup.mockInput.pressArrow("right"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("this session has no transcript yet");
    await act(async () => {
      setup.mockInput.pressEscape();
      await Bun.sleep(60); // bare ESC is emitted after the key parser's sequence timeout
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("resume · sessions in this folder");
    await act(async () => {
      setup.mockInput.pressEscape();
      await Bun.sleep(60); // bare ESC is emitted after the key parser's sequence timeout
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("resume · sessions");
    setup.renderer.destroy();
    rmSync(dir, { recursive: true, force: true });
  });
});
