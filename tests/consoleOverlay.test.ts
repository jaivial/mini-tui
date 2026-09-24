import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import { installConsoleClose } from "../src/consoleOverlay";

describe("error console overlay", () => {
  test("esc closes the console OpenTUI opens on an uncaught error", async () => {
    const { renderer, mockInput } = await createTestRenderer({ width: 80, height: 24 });
    installConsoleClose(renderer);
    const seen: string[] = [];
    renderer.keyInput.on("keypress", (k) => seen.push(k.name));

    // what renderer.handleError does on uncaughtException / unhandledRejection
    renderer.console.show();
    expect(renderer.console.visible).toBe(true);

    mockInput.pressEscape();
    await Bun.sleep(80); // bare esc is disambiguated after a short timeout
    expect(renderer.console.visible).toBe(false);
    expect(seen).not.toContain("escape"); // swallowed: the app did not also see it

    mockInput.pressEscape();
    await Bun.sleep(80);
    expect(seen).toContain("escape"); // console closed -> esc goes back to the app
    renderer.destroy();
  });

  test("ctrl+\\ toggles the console", async () => {
    const { renderer, mockInput } = await createTestRenderer({ width: 80, height: 24 });
    installConsoleClose(renderer);
    mockInput.pressKey("\\", { ctrl: true });
    await Bun.sleep(20);
    expect(renderer.console.visible).toBe(true);
    mockInput.pressKey("\\", { ctrl: true });
    await Bun.sleep(20);
    expect(renderer.console.visible).toBe(false);
    renderer.destroy();
  });
});
