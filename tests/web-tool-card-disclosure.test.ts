/**
 * The tool card's disclosure semantics, as they are actually written.
 *
 * WHAT WAS MEASURED, in Chrome 145 against the DEPLOYED build, on a real 58-card
 * transcript (`xfh-probe`):
 *
 *   - `aria-expanded` was on all 58 header buttons and pointed at NOTHING: 0 had an
 *     `aria-controls`, and 0 of the body elements had an `id`. It was a claim about
 *     no element, so a screen-reader user could not get from the toggle to the thing
 *     it toggles.
 *   - the one-line summary was `aria-hidden="true"`, so the header's accessible name
 *     was just the tool plus the state icon: `"bash OK"`. 58 cards, 6 distinct names,
 *     and 57 of 58 cards had visible text that was NOT in their accessible name
 *     (WCAG 2.5.3, Label in Name). There was no way to tell a `git status` from a
 *     failing deploy without opening every card.
 *   - the collapsed body stayed reachable. E14 made the body unmount on a TIMER, so
 *     for ~229 ms after the close click (measured: still mounted at 184 ms, gone at
 *     229 ms) the Copy buttons inside it were still focusable and still in the
 *     accessibility tree while the header said `aria-expanded="false"`.
 *
 * These assertions read the component rather than a rendered DOM: the whole defect is
 * about what the browser then did with the markup, so the measured proof that the
 * wiring works is live, against the deployed build (see log.md, E16).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source with the comments removed — matching raw text would test the prose, not the code.
 *
 * HTML comments count as comments here too: the first version of this file asserted
 * `not /role="region"/` and failed on its OWN explanatory comment, which is the exact
 * mistake the stripping exists to prevent.
 */
function read(...parts: string[]): string {
  return readFileSync(join(import.meta.dir, "..", ...parts), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const card = read("web", "src", "lib", "components", "StepCard.svelte");

describe("a tool card is a disclosure a screen reader can actually use", () => {
  test("every header points at its own body with aria-controls + an id", () => {
    // `$props.id()` is per instance, so two cards in the same transcript cannot collide.
    expect(card).toMatch(/\$props\.id\(\)/);
    expect(card).toMatch(/aria-controls="\{uid\}-body"/);
    expect(card).toMatch(/id="\{uid\}-body"/);
  });

  test("the summary is NOT aria-hidden: it is what tells two cards apart", () => {
    // This is the whole point of the card. With it hidden, all 58 headers announced as
    // "bash OK" and the transcript was unnavigable without sight.
    expect(card).not.toMatch(/aria-hidden="true"[^>]*>\s*\{\s*summary\s*\}/);
    expect(card).toMatch(/\{\s*summary\s*\}\s*<\/span>/);
  });

  test("the collapsed body is inert, not merely unmounted", () => {
    // E14 unmounts the body on a timer, which leaves a ~229 ms window where the Copy
    // buttons are still focusable while `aria-expanded` already says false. `inert`
    // closes it; unmounting alone cannot (and must not, or the closing animation dies).
    expect(card).toMatch(/inert=\{!expanded\}/);
  });

  test("the body is not a landmark: a transcript of tool calls must not flood the landmark list", () => {
    // A NAMED region is a landmark. 58 of them in one transcript is 58 stops in the
    // user's landmark menu to reach a place most of them do not go.
    expect(card).not.toMatch(/role="region"/);
  });

  test("the chevron stays decorative and the state icon keeps its label", () => {
    // Guards against over-correcting: the icons must not start announcing twice.
    expect(card).toMatch(/class="\{chev\} shrink-0 text-ink-faint" aria-hidden="true"/);
    expect(card).toMatch(/aria-label="Failed"/);
    expect(card).toMatch(/aria-label="OK"/);
  });

  test("the failed card still opens itself — the a11y fix must not change behaviour", () => {
    expect(card).toMatch(/if \(failed && !touched\) expanded = true;/);
    expect(card).toMatch(/touched = true;/);
  });

  test("the lazy body is untouched: this item is about semantics, not lifecycle", () => {
    // The E14 timer is what made the window above possible, but its answer is `inert`
    // here, not a second release mechanism. A regression guard on both halves.
    expect(card).toMatch(/createLazyBody\(\{/);
    expect(card).toMatch(/body\.transitionEnded\(e\.propertyName\)/);
    expect(card).toMatch(/onDestroy\(\(\) => body\.dispose\(\)\)/);
  });
});
