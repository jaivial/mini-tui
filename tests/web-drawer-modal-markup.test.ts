/**
 * The drawer's modal semantics, as they are actually written in the shell.
 *
 * `web-drawer-modal.test.ts` pins the RULES. This one pins the WIRING, and it exists because the
 * rules can be perfect and still not reach the user: the first version of the fix shipped the whole
 * module and left the markup untouched, so every unit test passed and Escape still did nothing.
 *
 * These assertions read App.svelte rather than a rendered DOM on purpose — a rendered-DOM test would
 * need a browser, and the whole defect is precisely that nobody looked at the rendered DOM. The
 * measured proof that the wiring now works is live, against the deployed build.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(import.meta.dir, "..", "web", "src", "App.svelte"), "utf8");

describe("the phone drawer is marked as the modal it is", () => {
  test("the rail is a labelled dialog while the window is narrow", () => {
    expect(app).toMatch(/role=\{narrow \? "dialog"/);
    expect(app).toMatch(/aria-modal=\{narrow \? "true"/);
  });
  test("the page behind it is inert, not merely painted over", () => {
    // Unpainted is not the same as unreachable: without inert those stops stay focusable and
    // clickable under the sheet, and a screen reader still reads the covered conversation.
    expect(app).toMatch(/inert=\{sidebarOpen && narrow\}/);
  });
});

describe("the drawer can be left with a keyboard", () => {
  test("Escape closes it, and it wins over the pane shortcuts", () => {
    expect(app).toMatch(/sidebarOpen && narrow && key === "Escape"/);
    // The branch has to come before the shortcuts, or Ctrl-something would win the key.
    const escape = app.indexOf('key === "Escape"');
    const firstShortcut = app.indexOf('key.toLowerCase() === "k"');
    expect(escape).toBeGreaterThan(-1);
    expect(escape).toBeLessThan(firstShortcut);
  });
  test("Tab is walked inside the drawer instead of falling through to the chat", () => {
    expect(app).toMatch(/sidebarOpen && narrow && code === "Tab" && drawer/);
    expect(app).toMatch(/nextStop\(focusableWithin\(drawer\)/);
  });
  test("closing hands focus back to the toggle that opened it", () => {
    expect(app).toMatch(/findToggle\(layout\)\?\.focus\(\)/);
  });
});

describe("no dead gesture left behind", () => {
  test("there is no backdrop div: the drawer covers it, so no press could reach it", () => {
    // Measured on the deployed build before the fix: the rail is `inset-0` at z-50 and the
    // backdrop is `inset-0` at z-40, so the backdrop had zero hittable pixels and a 400px swipe
    // over the rail closed nothing. The backdrop was unreachable markup pretending to be a
    // gesture, so it is gone rather than left looking like it still works.
    expect(app).not.toMatch(/bg-transparent/);
    expect(app).not.toMatch(/absolute inset-0 z-40/);
  });
  test("the swipe rides on the rail, which is the one thing a finger can actually touch", () => {
    expect(app).toMatch(/onpointerdown=\{\(e\) => narrow && \(swipeFrom = /);
    expect(app).toMatch(/if \(narrow && from && \(e\.clientY - from\.y > 64/);
  });
});
