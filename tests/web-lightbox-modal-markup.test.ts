/**
 * The lightbox's modal semantics, as they are actually written in the component.
 *
 * `web-lightbox-modal.test.ts` pins the RULES. This one pins the WIRING, and it exists because the
 * rules can be perfect and still not reach the user: the rules can describe a dialog that nobody
 * opened, or one the keyboard still walks out of.
 *
 * These assertions read the component rather than a rendered DOM on purpose — a rendered-DOM test
 * would need a browser, and the whole defect is precisely that the declared modal semantics
 * (`role="dialog" aria-modal="true"`) did not match what the browser then did. The measured proof
 * that the wiring works is live, against the deployed build.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source with the comments removed.
 *
 * A source file explains itself in prose, and this file quotes that prose back at the reader.
 * Matching the raw text would then test the comment rather than the code — the first version of
 * this file failed on its own explanation of `svelte:window`, which it was asserting was gone.
 */
function read(...parts: string[]): string {
  return readFileSync(join(import.meta.dir, "..", ...parts), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const lightbox = read("web", "src", "lib", "components", "Lightbox.svelte");
const markdown = read("web", "src", "lib", "components", "Markdown.svelte");
const engine = read("web", "src", "lib", "markdown.ts");

describe("the viewer is a real modal dialog, not a div that says it is one", () => {
  test("it is a <dialog> opened with showModal()", () => {
    // The native element owns the top layer, focus containment, the inert page behind and Escape.
    // Hand-rolling it in a div is what produced the defect: the ARIA said modal and the keyboard
    // did not agree.
    expect(lightbox).toMatch(/<dialog\b/);
    expect(lightbox).toMatch(/dialog\.showModal\(\)/);
    expect(lightbox).toMatch(/dialog\.close\(\)/);
  });

  test("it no longer claims modal semantics it was not delivering", () => {
    expect(lightbox).not.toMatch(/aria-modal/);
    expect(lightbox).not.toMatch(/role="dialog"/);
  });

  test("both exits — Escape and a backdrop click — close it", () => {
    // Escape arrives natively as a `close` event, so it lands in the same place as the click.
    expect(lightbox).toMatch(/onclose=\{oncloseevent\}/);
    expect(lightbox).toMatch(/event\.target === dialog/);
  });
});

describe("the zoom keys are bound to the dialog, not to the window", () => {
  test("no window-level key handler", () => {
    // THE regression: at window level these fired with focus anywhere on the page, so typing
    // "2+2" into the prompt produced "22" and left the image at 125%.
    expect(lightbox).not.toMatch(/svelte:window/);
  });

  test("the handler is on the dialog and asks whether focus is inside", () => {
    expect(lightbox).toMatch(/onkeydown=\{onkeydown\}/);
    expect(lightbox).toMatch(/insideDialog: dialog\?\.contains\(event\.target/);
  });

  test("the decision comes from the shared rules, not from a local copy", () => {
    expect(lightbox).toMatch(/from "\.\.\/lightboxModal"/);
    expect(lightbox).toMatch(/lightboxAction\(/);
  });
});

describe("an image in the transcript can be opened without a mouse", () => {
  test("it is focusable and announces that it is a control", () => {
    // An <img> is not focusable and carries no role: Tab walked straight past every picture in
    // the transcript, so there was no way to open the viewer at all from the keyboard.
    expect(engine).toMatch(/attrSet\("role", "button"\)/);
    expect(engine).toMatch(/attrSet\("tabindex", "0"\)/);
  });

  test("Enter and Space open it", () => {
    expect(markdown).toMatch(/onkeydown=\{onkeydown\}/);
    expect(markdown).toMatch(/event\.key !== "Enter"/);
    expect(markdown).toMatch(/"Spacebar"/);
  });

  test("the keyboard path opens the same viewer as a click", () => {
    expect(markdown).toMatch(/openLightbox\(img\.getAttribute\("src"\)/);
  });

  test("the container is not hidden from the accessibility tree", () => {
    // role="presentation" would strip the images — and the button role just added — out of it.
    expect(markdown).not.toMatch(/role="presentation"/);
  });
});
