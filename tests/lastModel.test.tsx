import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";

process.env.MINITUI_CONNECTIONS_PATH = "/dev/null/mini-tui-no-connections.json";

import { App } from "../src/ui/App";
import { loadLastModel, saveLastModel } from "../src/lastModel";

const dir = mkdtempSync(join(tmpdir(), "mini-tui-last-model-"));
const path = join(dir, "last-model.json");
process.env.MINITUI_LAST_MODEL_PATH = path;

async function pickModelFromPicker(setup: Awaited<ReturnType<typeof testRender>>, search: string) {
  await setup.mockInput.typeText("/model");
  await Bun.sleep(20);
  await act(async () => setup.mockInput.pressEnter()); // palette fills the prompt
  await setup.renderOnce();
  await act(async () => setup.mockInput.pressEnter()); // send /model
  await setup.renderOnce();
  await setup.mockInput.typeText(search);
  await Bun.sleep(20);
  await setup.renderOnce();
  await act(async () => setup.mockInput.pressEnter());
  await setup.renderOnce();
}

describe("last selected model", () => {
  test("load/save round trip, blanks and broken files", () => {
    rmSync(path, { force: true });
    expect(loadLastModel()).toBe("");
    saveLastModel("deepseek/deepseek-chat");
    expect(loadLastModel()).toBe("deepseek/deepseek-chat");
    saveLastModel("   "); // ignored
    expect(loadLastModel()).toBe("deepseek/deepseek-chat");
    writeFileSync(path, "{nope");
    expect(loadLastModel()).toBe("");
    rmSync(path, { force: true });
  });

  test("/model remembers the pick for fresh launches; an open TUI keeps its own model", async () => {
    rmSync(path, { force: true });
    // two TUIs open, both launched before anything was remembered
    const a = await testRender(<App cwd="." dbPath={join(dir, "a.sqlite")} onSend={() => {}} onQuit={() => {}} />, { width: 110, height: 30 });
    const b = await testRender(<App cwd="." dbPath={join(dir, "b.sqlite")} initialModel={loadLastModel() || undefined} onSend={() => {}} onQuit={() => {}} />, { width: 110, height: 30 });
    await a.renderOnce();
    await b.renderOnce();

    await pickModelFromPicker(a, "deepseek-flash");
    expect(a.captureCharFrame()).toContain("model → deepseek/deepseek-flash");
    expect(JSON.parse(readFileSync(path, "utf8")).model).toBe("deepseek/deepseek-flash");

    // the already-open TUI is untouched
    await b.renderOnce();
    expect(b.captureCharFrame()).toContain("default model");
    expect(b.captureCharFrame()).not.toContain("deepseek/deepseek-flash");

    // a fresh launch (index.ts passes loadLastModel() as initialModel) starts on it
    const c = await testRender(<App cwd="." dbPath={join(dir, "c.sqlite")} initialModel={loadLastModel() || undefined} onSend={() => {}} onQuit={() => {}} />, { width: 110, height: 30 });
    await c.renderOnce();
    expect(c.captureCharFrame()).toContain("deepseek/deepseek-flash");
    a.renderer.destroy();
    b.renderer.destroy();
    c.renderer.destroy();
    rmSync(dir, { recursive: true, force: true });
  });
});
