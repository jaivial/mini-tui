/**
 * The wiring the palette test cannot reach.
 *
 * `bubblePalette.ts` pins the numbers, but it is data: nothing stops the
 * component from going on painting the literals it replaced, or the app from
 * leaving `color-scheme` to the operating system. These read the real sources
 * for exactly that reason — the same approach `transcript-group.test.ts` uses
 * for the sender it compares against the one the header prints.
 *
 * Both defects were measured live against the deployed build in dark mode, with
 * the system preference set to LIGHT so the app's switch was the only thing
 * deciding: a link at 1.67:1 and a quote at 1.01:1 inside the user's bubble
 * (zero ink pixels — invisible), and a date field's calendar icon at 1.91:1,
 * against 17.38:1 with the system in dark. The icon is drawn by the BROWSER, so
 * it follows the declared `color-scheme`, which until now only existed as a
 * `<meta>` resolved against the system.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (...parts: string[]) => readFileSync(join(import.meta.dir, "..", ...parts), "utf8");
const withoutComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const transcript = src("web", "src", "lib", "components", "Transcript.svelte");
const appCss = src("web", "src", "app.css");
const uiStore = src("web", "src", "lib", "stores", "ui.svelte.ts");
const indexHtml = src("web", "index.html");

describe("the bubble's interior reads tokens, not literals", () => {
  test("no hardcoded colour is left inside the .msg-user block", () => {
    const block = transcript.slice(transcript.indexOf(".msg-user :global(.prose-mini a)"));
    // The literals that shipped the defect: the link's #9dc0ff, the quote's
    // 75%-white, and the three white overlays. Any of them back means the
    // palette is decorative again.
    expect(block).not.toMatch(/#9dc0ff/i);
    expect(block).not.toMatch(/rgb\(245 245 248 \/ 0\.75\)/);
    expect(block).not.toMatch(/rgb\(255 255 255 \/ 0\.(14|08|16)\)/);
    expect(block).not.toMatch(/rgb\(37 211 102 \/ 0\.45\)/);
  });

  test("each prose step is wired to the token that carries its number", () => {
    const css = withoutComments(transcript);
    expect(css).toMatch(/\.msg-user :global\(\.prose-mini a\) \{\s*color: var\(--color-bubble-user-link\)/);
    expect(css).toMatch(/\.msg-user :global\(\.prose-mini blockquote\) \{\s*color: var\(--color-bubble-user-quote\)/);
    expect(css).toMatch(/\.msg-user :global\(\.prose-mini code\) \{\s*background: var\(--color-bubble-user-chip\)/);
    expect(css).toMatch(/\.msg-user :global\(\.prose-mini pre\) \{[\s\S]{0,160}?background: var\(--color-bubble-user-pre\)/);
    expect(css).toMatch(/\.msg-user :global\(\.prose-mini pre\) \{[\s\S]{0,220}?border-color: var\(--color-bubble-user-pre-line\)/);
    expect(css).toMatch(/\.wa-mirror \{[\s\S]{0,120}?inset 0 -2px 0 var\(--color-bubble-user-mirror\)/);
  });

  test("both modes define every token the component reads", () => {
    // A token that exists in one mode only resolves to nothing in the other,
    // and the cascade silently falls back — the same "works in the mode you
    // happened to be looking at" failure, one step further out.
    const needed = ["link", "quote", "chip", "pre", "preLine", "mirror"];
    for (const step of needed) {
      const name = `--color-bubble-user-${step.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`;
      const definitions = [...appCss.matchAll(new RegExp(`${name}:`, "g"))].length;
      // Once in @theme (light) and once in :root.dark.
      expect(definitions).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("the mode the browser paints its own controls follows the app's switch", () => {
  test("app.css declares color-scheme on both modes", () => {
    // Without this the UA widgets resolve against the SYSTEM while every other
    // pixel resolves against the app — the measured 1.91:1 calendar icon.
    expect(appCss).toMatch(/:root\s*\{[\s\S]{0,2000}?color-scheme: light/);
    expect(appCss).toMatch(/:root\.dark\s*\{\s*color-scheme: dark/);
  });

  test("the store writes the property alongside the class it already toggles", () => {
    // Same switch, same moment: if only the class moved, the two would disagree
    // for every native control in the app.
    const apply = uiStore.slice(uiStore.indexOf("apply() {"), uiStore.indexOf("apply() {") + 900);
    expect(apply).toMatch(/classList\.toggle\("dark"/);
    expect(apply).toMatch(/style\.colorScheme = this\.theme/);
  });

  test("the pre-paint script sets it too, so the first paint is already right", () => {
    // The bundle boots after first paint; until it does, only this inline script
    // has spoken, and a date field's icon would paint in the system's mode.
    const head = indexHtml.slice(indexHtml.indexOf("minitui.theme"), indexHtml.indexOf("minitui.theme") + 700);
    expect(head).toMatch(/style\.colorScheme = t/);
  });

  test("the meta that resolves against the system is still there, untouched", () => {
    // It is not the fix, it is the fallback for before the app boots — it just
    // must not be the ONLY thing deciding.
    expect(indexHtml).toMatch(/<meta name="color-scheme" content="light dark"/);
  });
});
