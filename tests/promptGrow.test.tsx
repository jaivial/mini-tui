/**
 * The prompt box grows with the text the textarea actually wraps (word wrap, wide characters),
 * so the row a long word jumps onto is visible right away — not hidden below the box until an
 * edit shrinks it back into place.
 */
import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { TextareaRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";

import { App, estimatePromptRows } from "../src/ui/App";

process.env.MINITUI_CONNECTIONS_PATH = "/dev/null/mini-tui-no-connections.json";
process.env.MINITUI_LAST_MODEL_PATH = "/dev/null/mini-tui-no-last-model.json";

type Setup = Awaited<ReturnType<typeof testRender>>;

const findTextarea = (node: unknown): TextareaRenderable | undefined => {
  const n = node as { editorView?: unknown; getChildren?: () => unknown[] };
  if (n?.editorView) return n as unknown as TextareaRenderable;
  for (const child of n?.getChildren?.() ?? []) {
    const found = findTextarea(child);
    if (found) return found;
  }
};

/** The rows inside the prompt box's border, as painted. */
const promptLines = (setup: Setup) => {
  const lines = setup.captureCharFrame().split("\n");
  const bottom = lines.findLastIndex((line) => line.startsWith("╰"));
  const top = lines.findLastIndex((line, i) => i < bottom && line.startsWith("╭"));
  return lines.slice(top + 1, bottom).map((line) => line.slice(2, -2).trimEnd());
};

const mount = async (width = 60, height = 30) => {
  const setup = await testRender(
    <App cwd="." events={[]} info={{ cost: 0, apiCalls: 0 }} onSend={() => {}} onQuit={() => {}} />,
    { width, height },
  );
  await setup.renderOnce();
  const settle = async () => {
    await Bun.sleep(10);
    await setup.renderOnce();
    await Bun.sleep(5);
    await setup.renderOnce();
  };
  /** Box height equals the wrapped rows (up to 8) and, when everything fits, nothing is scrolled. */
  const check = () => {
    const area = findTextarea(setup.renderer.root)!;
    const wrapped = area.editorView.getTotalVirtualLineCount();
    expect(area.height).toBe(Math.min(8, Math.max(1, wrapped)));
    if (wrapped <= 8) expect(area.editorView.getViewport().offsetY).toBe(0);
    return area;
  };
  return { setup, settle, check };
};

// long words at a 56-column content width: word wrap needs rows the char count doesn't
const TEXT =
  "lorem ipsumdolorsit amet consecteturadipiscing elit seddoeiusmod tempor incididuntutlabore et doloremagna aliqua utenimad minimveniam quis";

describe("prompt box height follows the word-wrapped rows", () => {
  test("the char-count estimate falls short of word wrap for this text", () => {
    expect(estimatePromptRows(TEXT, 56)).toBe(3);
  });

  test("typing grows the box on the keystroke that wraps, every keystroke", async () => {
    const { setup, settle, check } = await mount();
    for (const ch of TEXT) {
      await act(async () => setup.mockInput.typeText(ch));
      await settle();
      check();
    }
    const lines = promptLines(setup);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toStartWith("lorem ipsumdolorsit");
    expect(lines.at(-1)).toEndWith("minimveniam quis");
    setup.renderer.destroy();
  });

  test("past 8 rows the box stops at 8 and the cursor row stays visible", async () => {
    const { setup, settle, check } = await mount();
    for (let i = 0; i < 12; i++) {
      await act(async () => setup.mockInput.typeText(`line${i} alphabetagammadelta epsilonzetaetatheta iotakappalambda `));
      await settle();
      check();
    }
    await act(async () => setup.mockInput.typeText("LAST"));
    await settle();
    expect(check().height).toBe(8);
    expect(promptLines(setup).join("\n")).toContain("LAST");
    setup.renderer.destroy();
  });

  test("deleting shrinks the box back, and submitting resets it to one row", async () => {
    const { setup, settle, check } = await mount();
    await act(async () => setup.mockInput.typeText(TEXT));
    await settle();
    expect(check().height).toBe(3);
    for (let i = 0; i < 40; i++) await act(async () => setup.mockInput.pressBackspace());
    await settle();
    expect(check().height).toBe(2);
    await act(async () => setup.mockInput.pressEnter());
    await settle();
    expect(check().height).toBe(1);
    setup.renderer.destroy();
  });

  test("wide characters (two columns each) grow the box too", async () => {
    const { setup, settle, check } = await mount();
    await act(async () => setup.mockInput.typeText("中文字符".repeat(12)));
    await settle();
    expect(check().height).toBeGreaterThanOrEqual(2);
    setup.renderer.destroy();
  });

  test("a narrower terminal re-wraps and regrows the box", async () => {
    const { setup, settle, check } = await mount(100);
    await act(async () => setup.mockInput.typeText(TEXT));
    await settle();
    expect(check().height).toBe(2);
    await act(async () => setup.resize(50, 30));
    await settle();
    check();
    expect(check().height).toBeGreaterThanOrEqual(3);
    setup.renderer.destroy();
  });
});
