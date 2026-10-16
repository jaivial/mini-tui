/**
 * The image lightbox as a modal: keys belong to whoever has them, and the zoom steps stay sane.
 *
 * The bugs these reproduce were measured on the deployed build, not reasoned about: the viewer
 * declared `role="dialog" aria-modal="true"` but Tab walked straight out of it — 6 of the first
 * 12 stops landed on controls with zero visible pixels — the page behind was never `inert`, and
 * the zoom keys were bound to the window, so typing "2+2" into the prompt produced "22" with the
 * image at 125 %.
 *
 * These test the RULES in `web/src/lib/lightboxModal.ts`, which is where the decision lives. The
 * containment itself is the browser's (`<dialog>` + `showModal()`), and the wiring that reaches
 * it is pinned in `web-lightbox-modal-markup.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  ZOOM_IN,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_OUT,
  ZOOM_TOGGLE_IN,
  ZOOM_WHEEL_IN,
  ZOOM_WHEEL_OUT,
  applyZoomAction,
  applyZoomToggle,
  lightboxAction,
  zoomBy,
} from "../web/src/lib/lightboxModal";

const INSIDE = { open: true, insideDialog: true } as const;

describe("the viewer claims a key only when it is the one being talked to", () => {
  test("Escape closes it, from inside", () => {
    expect(lightboxAction("Escape", INSIDE)).toBe("close");
  });

  test("the zoom keys work from inside", () => {
    expect(lightboxAction("+", INSIDE)).toBe("zoom-in");
    expect(lightboxAction("=", INSIDE)).toBe("zoom-in");
    expect(lightboxAction("-", INSIDE)).toBe("zoom-out");
  });

  test("Shift is not excluded: it is what produces '+' on most layouts", () => {
    // A layout with a dedicated '+' key and one where Shift+= is the only route both have to work.
    expect(lightboxAction("+", { ...INSIDE, shiftKey: true } as never)).toBe("zoom-in");
  });

  test("a key arriving with focus elsewhere is not the viewer's", () => {
    // THE regression: at window level these fired with focus anywhere on the page, so typing a
    // plus sign in the prompt zoomed the image and swallowed the character.
    expect(lightboxAction("+", { open: true, insideDialog: false })).toBeNull();
    expect(lightboxAction("Escape", { open: true, insideDialog: false })).toBeNull();
  });

  test("a closed viewer claims nothing", () => {
    expect(lightboxAction("Escape", { open: false, insideDialog: true })).toBeNull();
    expect(lightboxAction("+", { open: false, insideDialog: false })).toBeNull();
  });

  test("browser and OS zoom shortcuts are left alone", () => {
    // Taking these would remove a shortcut the user relies on to serve a feature they did not ask for.
    expect(lightboxAction("+", { ...INSIDE, ctrlKey: true })).toBeNull();
    expect(lightboxAction("-", { ...INSIDE, metaKey: true })).toBeNull();
    expect(lightboxAction("+", { ...INSIDE, altKey: true })).toBeNull();
  });

  test("ordinary typing keys are none of its business", () => {
    for (const key of ["a", "Enter", "Tab", "ArrowRight", " ", "Backspace"]) {
      expect(lightboxAction(key, INSIDE)).toBeNull();
    }
  });
});

describe("the zoom stays inside the range the toolbar advertises", () => {
  test("one step in and out from the start", () => {
    expect(zoomBy(1, ZOOM_IN)).toBe(1.25);
    expect(zoomBy(1, ZOOM_OUT)).toBe(1); // already at the floor, stays there
  });

  test("clamped at both ends", () => {
    expect(zoomBy(ZOOM_MAX, ZOOM_IN)).toBe(ZOOM_MAX);
    expect(zoomBy(ZOOM_MIN, ZOOM_OUT)).toBe(ZOOM_MIN);
  });

  test("rounded, so the printed percentage is the zoom actually reached", () => {
    // A run of *1.25 from 1 lands on 3.8125, which read as "381%" while the image was at 381.25%.
    let zoom = 1;
    for (let i = 0; i < 5; i += 1) zoom = zoomBy(zoom, ZOOM_IN);
    expect(zoom).toBe(3.05);
    expect(Math.round(zoom * 100)).toBe(Math.round(3.05 * 100));
    expect(Number.isInteger(zoom * 100)).toBe(true);
  });

  test("the wheel is finer than a click, and stays that way", () => {
    // Both used to be one constant in some versions; sharing one would quietly change the feel.
    expect(ZOOM_WHEEL_IN).toBeLessThan(ZOOM_IN);
    expect(ZOOM_WHEEL_OUT).toBeGreaterThan(ZOOM_OUT);
    expect(zoomBy(1, ZOOM_WHEEL_IN)).toBeLessThan(zoomBy(1, ZOOM_IN));
  });

  test("an action leaves the zoom alone when it only closes", () => {
    expect(applyZoomAction(2, "close")).toBe(2);
    expect(applyZoomAction(1, "zoom-in")).toBe(1.25);
    expect(applyZoomAction(1.25, "zoom-out")).toBe(1);
  });
});

describe("a double-click puts the image back how it was found", () => {
  test("from any zoom above 1 it returns to exactly 1x", () => {
    // One step out of an odd zoom would leave 1.25 — still zoomed — and pressing again creeps on.
    for (const zoom of [1.56, 2.44, 3.81, 4]) {
      expect(applyZoomToggle(zoom)).toBe(1);
    }
  });

  test("from 1x it jumps in", () => {
    expect(applyZoomToggle(1)).toBe(ZOOM_TOGGLE_IN);
  });
});
