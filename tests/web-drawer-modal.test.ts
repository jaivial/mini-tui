/**
 * The phone drawer as a modal: Escape out, Tab contained, the page behind inert.
 *
 * The bug these reproduce was measured on the deployed build, not reasoned about: on a 390px
 * window the bots list covers the whole screen, and with nothing marking it as a modal the
 * keyboard walked straight out of it into the chat painted behind — 6 of the first 12 Tab stops
 * landed on controls with zero visible pixels — Escape did nothing at all, and the swipe-to-close
 * was attached to a backdrop the drawer sits on top of, so no press could ever reach it.
 *
 * These test the RULES in `web/src/lib/drawerModal.ts`, which is where the decision lives. The DOM
 * here is a small hand-built stand-in, because the point being pinned is the walk itself: which
 * stops it counts, and where it wraps.
 */
import { describe, expect, test } from "bun:test";
import { findToggle, focusableWithin, isFocusable, nextStop } from "../web/src/lib/drawerModal";

/** A minimal element stand-in: enough of HTMLElement for the walk, none of the browser's judgement. */
class FakeElement {
  tagName: string;
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  rects = 1;
  hidden = false;
  inertAncestor = false;
  children: FakeElement[] = [];
  parent: FakeElement | null = null;

  constructor(tagName: string, attrs: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase();
    this.attrs = attrs;
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  get hiddenAttr() {
    return this.hidden;
  }
  getClientRects() {
    return this.rects ? [{}] : [];
  }
  contains(other: FakeElement): boolean {
    if (other === this) return true;
    return this.children.some((c) => c.contains(other));
  }
  closest(sel: string): FakeElement | null {
    let n: FakeElement | null = this;
    while (n) {
      if (sel === "[inert]" && n.inertAncestor) return n;
      n = n.parent;
    }
    return null;
  }
  /** Enough of Element.matches for the selector list the module uses: tags, [attr], [attr=v], :not(). */
  matches(sel: string): boolean {
    return sel.split(",").some((one) => this.matchesOne(one.trim()));
  }
  private matchesOne(sel: string): boolean {
    const m = /^([a-z]+)?(?:\[([^\]]+)\])?(?::not\(\[([^\]]+)\]\))?$/i.exec(sel);
    if (!m) throw new Error(`fake selector out of vocabulary: ${sel}`);
    const [, tag, attr, notAttr] = m;
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (attr && !this.hasAttr(attr)) return false;
    if (notAttr && this.hasAttr(notAttr)) return false;
    return true;
  }
  private hasAttr(expr: string): boolean {
    const eq = expr.indexOf("=");
    if (eq === -1) return expr in this.attrs;
    const key = expr.slice(0, eq);
    return this.attrs[key] === expr.slice(eq + 1).replace(/^["']|["']$/g, "");
  }
  querySelectorAll(): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (n: FakeElement) => n.children.forEach((c) => (out.push(c), walk(c)));
    walk(this);
    return out;
  }
  querySelector(): FakeElement | null {
    return this.querySelectorAll()[0] ?? null;
  }
  focus() {
    FakeElement.focused = this;
  }
  static focused: FakeElement | null = null;
}

/** Install the fake globals the module reads, and hand the fake document back. */
function withDom<T>(fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const savedEl = g.HTMLElement;
  const savedGc = g.getComputedStyle;
  g.HTMLElement = FakeElement as unknown;
  g.getComputedStyle = (el: FakeElement) => el.style;
  try {
    return fn();
  } finally {
    g.HTMLElement = savedEl;
    g.getComputedStyle = savedGc;
  }
}

function el(tag: string, attrs: Record<string, string> = {}, style: Record<string, string> = {}): FakeElement {
  const e = new FakeElement(tag, attrs);
  e.style = style;
  return e;
}

/** The drawer's rail: close button, search field, three bot rows, new-bot button. */
function drawer(): FakeElement {
  const root = el("div", { role: "dialog" });
  const close = el("button", { "aria-label": "Close the bots list" });
  const search = el("input", { "aria-label": "Search bots" });
  const row1 = el("button", { "aria-label": "Show Escuchame" });
  const row2 = el("button", { "aria-label": "Escuchame" });
  const newBot = el("button", { "aria-label": "New bot" });
  for (const c of [close, search, row1, row2, newBot]) {
    c.parent = root;
    root.children.push(c);
  }
  return root;
}

describe("isFocusable", () => {
  test("a button is a stop; a disabled one is not", () => {
    withDom(() => {
      expect(isFocusable(el("button", { "aria-label": "a" }))).toBe(true);
      expect(isFocusable(el("button", { disabled: "" }))).toBe(false);
    });
  });
  test("a plain div is not a stop", () => {
    withDom(() => expect(isFocusable(el("div"))).toBe(false));
  });
  test("tabindex=-1 opts OUT of the walk, tabindex=0 opts in", () => {
    withDom(() => {
      expect(isFocusable(el("div", { tabindex: "-1" }))).toBe(false);
      expect(isFocusable(el("div", { tabindex: "0" }))).toBe(true);
    });
  });
  test("something the browser has not laid out takes no focus", () => {
    withDom(() => {
      const collapsed = el("button", { "aria-label": "a" });
      collapsed.rects = 0;
      expect(isFocusable(collapsed)).toBe(false);
    });
  });
  test("display:none and visibility:hidden take no focus", () => {
    withDom(() => {
      expect(isFocusable(el("button", {}, { display: "none" }))).toBe(false);
      expect(isFocusable(el("button", {}, { visibility: "hidden" }))).toBe(false);
    });
  });
});

describe("focusableWithin", () => {
  test("it returns the drawer's own stops in DOM order", () => {
    withDom(() => {
      const stops = focusableWithin(drawer() as unknown as Element);
      expect(stops.map((s) => s.getAttribute("aria-label"))).toEqual([
        "Close the bots list",
        "Search bots",
        "Show Escuchame",
        "Escuchame",
        "New bot",
      ]);
    });
  });
  test("THE DEFECT: a stop behind an inert page is invisible to the walk", () => {
    // This is the whole point of the walk being scoped to the drawer. The chat behind the sheet is
    // real, focusable DOM; without the scope Tab walks out of the rail and into controls with zero
    // pixels, and the keyboard cursor disappears.
    withDom(() => {
      const rail = drawer();
      const page = el("div");
      page.inertAncestor = true;
      const behind = el("textarea", { "aria-label": "Message mini-tui…" });
      behind.parent = page;
      page.children.push(behind);
      const stops = focusableWithin(rail as unknown as Element);
      expect(stops.map((s) => s.getAttribute("aria-label"))).not.toContain("Message mini-tui…");
      expect(isFocusable(behind as unknown as Element)).toBe(false);
    });
  });
  test("a disabled control inside the drawer is skipped rather than focused", () => {
    withDom(() => {
      const rail = drawer();
      const dead = el("button", { "aria-label": "Muted", disabled: "" });
      dead.parent = rail;
      rail.children.push(dead);
      expect(focusableWithin(rail as unknown as Element).map((s) => s.getAttribute("aria-label"))).not.toContain("Muted");
    });
  });
});

describe("nextStop", () => {
  test("Tab advances through the drawer and wraps back to the first stop", () => {
    withDom(() => {
      const stops = focusableWithin(drawer() as unknown as Element);
      expect(nextStop(stops as unknown as HTMLElement[], stops[0] as unknown as Element)?.getAttribute("aria-label")).toBe("Search bots");
      expect(nextStop(stops as unknown as HTMLElement[], stops[3] as unknown as Element)?.getAttribute("aria-label")).toBe("New bot");
      // The wrap is what keeps Tab off the chat behind.
      expect(nextStop(stops as unknown as HTMLElement[], stops[4] as unknown as Element)?.getAttribute("aria-label")).toBe("Close the bots list");
    });
  });
  test("Shift+Tab walks backwards and wraps the other way", () => {
    withDom(() => {
      const stops = focusableWithin(drawer() as unknown as Element);
      expect(nextStop(stops as unknown as HTMLElement[], stops[2] as unknown as Element, true)?.getAttribute("aria-label")).toBe("Search bots");
      expect(nextStop(stops as unknown as HTMLElement[], stops[0] as unknown as Element, true)?.getAttribute("aria-label")).toBe("New bot");
    });
  });
  test("focus outside the drawer enters at the near end, never past it", () => {
    withDom(() => {
      const stops = focusableWithin(drawer() as unknown as Element);
      // Focus sat on the header toggle, which the drawer covers; Tab has to bring it IN.
      expect(nextStop(stops as unknown as HTMLElement[], null)?.getAttribute("aria-label")).toBe("Close the bots list");
      expect(nextStop(stops as unknown as HTMLElement[], null, true)?.getAttribute("aria-label")).toBe("New bot");
    });
  });
  test("an empty drawer has nowhere to send Tab", () => {
    withDom(() => expect(nextStop([], null)).toBeNull());
  });
  test("a one-stop drawer holds still: Tab there means 'leave', not spin", () => {
    withDom(() => {
      const only = el("button", { "aria-label": "Close" });
      const stops = [only] as unknown as HTMLElement[];
      expect(nextStop(stops, only as unknown as Element)).toBeNull();
    });
  });
});

describe("findToggle", () => {
  test("it finds the header control by its accessible name, not by position", () => {
    withDom(() => {
      const root = el("div");
      const decoy = el("button", { "aria-label": "Bot menu" });
      const toggle = el("button", { "aria-label": "Toggle bots list" });
      for (const c of [decoy, toggle]) (c.parent = root), root.children.push(c);
      expect(findToggle(root as unknown as ParentNode)?.getAttribute("aria-label")).toBe("Toggle bots list");
    });
  });
  test("a header without the toggle returns null rather than guessing at another control", () => {
    withDom(() => {
      const root = el("div");
      const other = el("button", { "aria-label": "Bot menu" });
      (other.parent = root), root.children.push(other);
      expect(findToggle(root as unknown as ParentNode)).toBeNull();
    });
  });
});
