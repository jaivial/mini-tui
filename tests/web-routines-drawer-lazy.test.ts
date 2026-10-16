/**
 * The Routines drawer must not build its board until somebody opens it.
 *
 * Measured against the deployed build (main, `c4407d6`) at 390x844: the drawer shipped 236 task
 * cards = 8,981 DOM nodes on EVERY load, for a drawer with `open === false` — 97% of the whole
 * document (9,256 of 9,256 nodes against 273 without), 1,060 KB of serialized HTML against 85 KB,
 * 316 ms of main-thread CPU against 110 ms, and a 19.9 MB heap against 5.2 MB. A `<dialog>` that is
 * not open is `display: none`, so none of it was painted; all of it was built, on every visit.
 *
 * Why there was no test for it: nothing here was wrong. The cards rendered, the counts were right,
 * the drawer opened and showed them. It only shows up if you count what the app builds when nobody
 * is looking — which is why the numbers above are pinned here rather than a "does it render" check.
 *
 * The assertions read the component's source on purpose: the defect is a lifecycle one (built when
 * it should not be), and a rendered-DOM test would need a browser. The measured proof that the
 * board still appears the instant it is asked for is live, against the deployed build.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const panel = readFileSync(join(import.meta.dir, "..", "web", "src", "lib", "components", "TasksPanel.svelte"), "utf8");

describe("the routines board is not built while the drawer is closed", () => {
  test("the list hangs off a latch that only opens with the drawer", () => {
    expect(panel).toMatch(/let seen = \$state\(false\)/);
    // The latch is set by `open` and nothing else, so a closed drawer can never build the board.
    expect(panel).toMatch(/\$effect\(\(\) => \{\s*if \(open\) seen = true;/);
  });

  test("every row of the board is inside the latch, not beside it", () => {
    // The header (the count) stays: it is one text node, and it is what the menu row quotes.
    const headerAt = panel.indexOf("<header");
    const latchAt = panel.indexOf("{#if !seen}");
    const queueAt = panel.indexOf("<QueueSection");
    const emptyAt = panel.indexOf('<p class="px-2 py-6');
    const rowsAt = panel.indexOf("{#each rows as row (row.task.id)}");
    const footerAt = panel.indexOf("<footer");
    for (const at of [latchAt, queueAt, emptyAt, rowsAt]) expect(at).toBeGreaterThan(-1);
    // header < latch < the three sections < footer: nothing of the board escaped it.
    expect(headerAt).toBeLessThan(latchAt);
    expect(latchAt).toBeLessThan(queueAt);
    expect(queueAt).toBeLessThan(emptyAt);
    expect(emptyAt).toBeLessThan(rowsAt);
    expect(rowsAt).toBeLessThan(footerAt);
  });

  test("the latch never clears, so the board is still live once it has been opened", () => {
    // If it reset on close, reopening would rebuild 236 cards and the drawer would stutter every
    // time — the fix would trade a hidden cost for a visible one.
    expect(panel).not.toMatch(/else seen = false/);
    expect(panel).not.toMatch(/seen = false/);
    // And the sections that poll are still given `open`, so they only watch while it is on screen.
    expect(panel).toMatch(/<QueueSection \{open\} \/>/);
    expect(panel).toMatch(/<ChannelsSection \{open\} \/>/);
  });
});
