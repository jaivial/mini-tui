/**
 * The terminal's ANSI sixteen, as they are actually WIRED.
 *
 * `web-terminal-ansi-palette.test.ts` pins the rules. This one pins that the
 * panel applies them, and it exists for the same reason the lightbox's markup
 * test does: the rules can be perfect, fully green, and reach nobody. The first
 * version of this defect was not a bad palette — it was a correct-looking
 * `theme()` that set six fields and let xterm's stock sixteen through, so
 * nothing failed and the shell was still unreadable.
 *
 * These read the component rather than a rendered DOM on purpose: the whole
 * defect is that what the browser then painted did not match what the source
 * appeared to configure. The proof that the wiring works is measured live,
 * against the deployed build.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Source with the comments stripped: a comment quoting the rules would test itself. */
function read(...parts: string[]): string {
  return readFileSync(join(import.meta.dir, "..", ...parts), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const panel = read("web", "src", "lib", "components", "TerminalPanel.svelte");

describe("the terminal panel applies the themed ANSI palette", () => {
  test("theme() spreads all sixteen slots into what xterm is given", () => {
    // The six fields it already set (background, foreground, cursor…) are not the
    // subject here; the sixteen are what were falling through to the defaults.
    expect(panel).toMatch(/\.\.\.ansiTheme\(/);
    expect(panel).toMatch(/paletteFor\(ui\.theme\)/);
  });

  test("it imports the palette from the module that owns the numbers", () => {
    expect(panel).toMatch(/import\s*\{[^}]*ansiTheme[^}]*\}\s*from\s*"[^"]*terminalPalette"/);
    expect(panel).toMatch(/import\s*\{[^}]*paletteFor[^}]*\}\s*from\s*"[^"]*terminalPalette"/);
  });

  test("the palette is chosen from the live theme, not hard-coded to one mode", () => {
    // A literal "light" here would silently break dark mode, which is the case
    // nobody tests by hand.
    expect(panel).not.toMatch(/ansiTheme\(paletteFor\(\s*["']light["']\s*\)\)/);
    expect(panel).not.toMatch(/ansiTheme\(paletteFor\(\s*["']dark["']\s*\)\)/);
  });

  test("the theme object is still built and handed to xterm on creation", () => {
    expect(panel).toMatch(/theme:\s*theme\(\)/);
  });

  test("a theme switch repaints the sixteen too, not only the six", () => {
    // This is the live flip C2 fixed for the lightbox and it applies here: if the
    // effect re-set only background/foreground, switching mode would leave the
    // accents from the previous one — readable on neither surface.
    const effect = panel.slice(panel.indexOf("$effect"));
    expect(effect).toMatch(/term\.options\.theme\s*=\s*theme\(\)/);
    // And it must depend on the theme, or it never re-runs on a flip.
    const themeEffect = panel.slice(panel.lastIndexOf("$effect"));
    expect(themeEffect).toMatch(/ui\.theme/);
  });

  test("no inline hex palette is smuggled into the component", () => {
    // The numbers belong in terminalPalette.ts, where the tests can measure them.
    // A second copy here would be one the suite never checks.
    expect(panel).not.toMatch(/brightYellow/);
    expect(panel).not.toMatch(/brightBlack/);
    expect(panel).not.toMatch(/#8ae234|#fce94f|#eeeeee/i);
  });
});
