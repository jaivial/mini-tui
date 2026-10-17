/**
 * The generative form and chart, pinned where they can be measured without a DOM.
 *
 * The defects these exist for were measured against the built app in Chrome, with
 * the real `ui-component` events arriving over a real session socket:
 *
 *  1. `UiForm` reset its draft off `props` identity. A snapshot rebuilds every
 *     event object, so the same form on screen was "a different form": a typed
 *     draft was thrown away and `sent` went back to false, which re-armed a
 *     submit button that had ALREADY delivered the form. Measured: the same
 *     answer reached `/api/sessions/<id>/prompt` twice, byte for byte.
 *  2. The visible hint said "⌘ Enter para enviar" and there was no keydown
 *     handler anywhere in the component: measured, ⌘Enter and Ctrl+Enter sent
 *     nothing from any field, and a `<select>` swallows plain Enter as well.
 *  3. The chart was `role="img"` named only by its title, and its label row is
 *     `aria-hidden`: the accessibility tree held one `image` node naming the
 *     caption and not one node naming any value. The marks are rects.
 */
import { describe, expect, test } from "bun:test";
import { formatValue } from "../web/src/lib/ui/chartGeometry";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const component = (name: string) =>
  readFileSync(join(import.meta.dir, "..", "web", "src", "lib", "components", "ui", name), "utf8")
    // The tests that read a component have to strip HTML comments too: the fix is
    // documented in one, and a test that trips on its own documentation is
    // measuring nothing.
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const form = component("UiForm.svelte");
const chart = component("UiChart.svelte");

describe("the draft belongs to the form on screen, not to the object that carried it", () => {
  test("the reset keys off the rendered signature, not off `props` identity", () => {
    // The defect: `$effect(() => { props; ... })` fires on every snapshot, because
    // the snapshot is what hands the store new event objects.
    expect(form).not.toMatch(/\$\(\)\s*=>\s*\{\s*props;/);
    expect(form).toMatch(/const signature = \$derived\(/);
    expect(form).toMatch(/if \(lastSignature === undefined \|\| signature === lastSignature\)/);
    expect(form).toMatch(/lastSignature = signature;\s*\n\s*values = \{\};/);
  });

  test("the signature names the fields, so a different form still resets", () => {
    expect(form).toMatch(/fields\.map\(\(f\) => `\$\{f\.name\}:\$\{f\.type\}`\)/);
  });

  test("`sent` is latched after the answer is complete, before the send", () => {
    // Both orders are wrong in one direction: latching before the required check
    // would disable the button forever on an incomplete answer; latching after the
    // send leaves the window open.
    const latch = form.indexOf("sent = true;");
    const guard = form.indexOf("field.required &&");
    const send = form.indexOf("onsubmit?.(");
    expect(guard).toBeGreaterThan(-1);
    expect(latch).toBeGreaterThan(guard);
    expect(latch).toBeLessThan(send);
  });

  test("the button state is driven by the latch, and the guard refuses a second send", () => {
    expect(form).toMatch(/if \(!form\.ok \|\| sent\) return;/);
    expect(form).toMatch(/disabled=\{sent\}/);
  });
});

describe("the shortcut the hint promises exists", () => {
  test("every field type handles ⌘/Ctrl+Enter", () => {
    // A <select> swallows plain Enter (it opens the dropdown) and implicit submit
    // is not dependable with a date or a number field in the form, so the handler
    // hangs off the fields: three of them, or the shortcut silently misses one.
    expect(form).toMatch(/function onFieldKey\(event: KeyboardEvent\)/);
    expect(form).toMatch(/event\.key !== "Enter" \|\| !\(event\.metaKey \|\| event\.ctrlKey\)/);
    expect(form).toMatch(/\.form\?\.requestSubmit\(\)/);
    const select = (form.match(/<select[\s\S]{0,200}?>/) ?? [""])[0];
    const checkbox = (form.match(/type="checkbox"[\s\S]{0,300}?\/>/) ?? [""])[0];
    const input = (form.match(/type=\{field\.type\}[\s\S]{0,300}?\/>/) ?? [""])[0];
    for (const [name, chunk] of [["select", select], ["checkbox", checkbox], ["input", input]]) {
      expect(`${name}:${chunk.includes("onkeydown={onFieldKey}")}`).toBe(`${name}:true`);
    }
  });

  test("the hint text names the keys that work", () => {
    // The defect's visible half: the hint promised ⌘Enter and nothing listened.
    // Anchored on the old sentence in full, since the new one contains the old as
    // a substring — a loose matcher here would pass with the defect still there.
    expect(form).not.toContain(">⌘ Enter para enviar</span>");
    expect(form).toContain(">Enter o ⌘ Enter para enviar</span>");
  });

  test("the hint is announced, not just drawn", () => {
    // It was a visible span and nothing else: a reader of the form never heard
    // the affordance that the keyboard shortcut depends on.
    expect(form).toMatch(/aria-describedby="\{uid\}-hint"/);
    expect(form).toMatch(/id="\{uid\}-hint"/);
  });
});

describe("the chart says its data out loud", () => {
  test("the svg carries a description, not only a name", () => {
    expect(chart).toMatch(/aria-describedby="\{uid\}-data"/);
    expect(chart).toMatch(/<desc id="\{uid\}-data">\{summary\}<\/desc>/);
  });

  test("the summary names the kind, the caption, and every point", () => {
    expect(chart).toMatch(/Gráfico de \$\{chart\.props\.kind === "bar" \? "barras" : "líneas"\}/);
    expect(chart).toMatch(/chart\.props\.labels\.map\(\(label, i\) =>/);
    expect(chart).toMatch(/formatValue\(chart\.props\.values\[i\]!\)/);
  });

  test("the unit rides along with the number", () => {
    expect(chart).toMatch(/chart\.props\.unit \? ` \$\{chart\.props\.unit\}` : ""/);
  });

  test("the visual label row stays out of the way of the description", () => {
    // It is aria-hidden and always was; the point is that the DATA moved into the
    // description rather than the labels being un-hidden and read twice.
    expect(chart).toMatch(/<div class="ui-chart-labels" aria-hidden="true">/);
  });
});
