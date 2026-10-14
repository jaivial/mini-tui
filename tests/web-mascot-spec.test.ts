/** The squishmoji mascot rules: spec clamping, the state→expression mapping, determinism, id scoping. */
import { describe, expect, test } from "bun:test";
import {
  HOUSE_MASCOT,
  STATE_EXPRESSION,
  clampMascotSpec,
  mascotSpecFor,
  renderMascot,
  scopeSvgIds,
  statusState,
} from "../web/src/lib/mascot";

describe("clampMascotSpec", () => {
  test("anything outside the catalog becomes 'all' — a seed-driven pick", () => {
    const spec = clampMascotSpec({ seed: "s", shape: "dragon" as never, expression: "stoned" as never, background_style: "nebula" as never }, "fb");
    expect(spec.shape).toBe("all");
    expect(spec.expression).toBe("all");
    expect(spec.background_style).toBe("all");
  });
  test("in-catalog values pass through; the seed falls back when missing or blank", () => {
    const spec = clampMascotSpec({ seed: "  ", shape: "cat", expression: "curious", background_style: "maia" }, "fb");
    expect(spec.seed).toBe("fb");
    expect(spec.shape).toBe("cat");
    expect(spec.expression).toBe("curious");
    expect(spec.background_style).toBe("maia");
  });
  test("no spec at all: everything seed-driven off the fallback", () => {
    const spec = clampMascotSpec(null, "fb");
    expect(spec.seed).toBe("fb");
    expect(spec.shape).toBe("all");
    expect(spec.expression).toBe("all");
  });
});

describe("STATE_EXPRESSION", () => {
  test("the contract's §11.3 mapping", () => {
    expect(STATE_EXPRESSION.idle).toBeNull(); // idle keeps the stored expression
    expect(STATE_EXPRESSION.thinking).toBe("curious");
    expect(STATE_EXPRESSION.tool).toBe("determined");
    expect(STATE_EXPRESSION.success).toBe("happy");
    expect(STATE_EXPRESSION.error).toBe("sad");
    expect(STATE_EXPRESSION.waiting).toBe("attentive");
  });
  test("statusState maps the session statuses onto it", () => {
    expect(statusState(null)).toBe("idle");
    expect(statusState("running")).toBe("thinking");
    expect(statusState("done")).toBe("success");
    expect(statusState("error")).toBe("error");
    expect(statusState("interrupted")).toBe("error");
  });
});

describe("renderMascot", () => {
  test("deterministic: the same spec and state render the same svg", () => {
    const spec = mascotSpecFor("agent-1");
    expect(renderMascot(spec, "thinking", 32)).toBe(renderMascot(spec, "thinking", 32));
  });
  test("the state picks the expression: same spec, different state, different face", () => {
    const spec = mascotSpecFor("agent-1");
    const idle = renderMascot(spec, "idle", 32);
    expect(renderMascot(spec, "error", 32)).not.toBe(idle);
    expect(renderMascot(spec, "success", 32)).not.toBe(idle);
    expect(renderMascot(spec, "thinking", 32)).not.toBe(idle);
  });
  test("seeds are stable: same id after a 'reload', same avatar; different ids differ", () => {
    expect(renderMascot(mascotSpecFor("pane-7"), "idle", 24)).toBe(renderMascot(mascotSpecFor("pane-7"), "idle", 24));
    expect(renderMascot(mascotSpecFor("pane-7"), "idle", 24)).not.toBe(renderMascot(mascotSpecFor("pane-8"), "idle", 24));
  });
  test("the svg is real markup, not a pixel reference", () => {
    const svg = renderMascot(HOUSE_MASCOT, "idle", 22);
    expect(svg).toMatch(/^<svg/);
    expect(svg).not.toMatch(/\.webp|\.png|<img/);
  });
});

describe("scopeSvgIds", () => {
  test("suffixes ids and rewrites every reference to them", () => {
    const svg = `<svg><defs><clipPath id="clip-a"></clipPath><linearGradient id="g1"></linearGradient></defs>
      <g clip-path="url(#clip-a)" fill="url(#g1)"><use href="#clip-a"></use></g></svg>`;
    const scoped = scopeSvgIds(svg, "sq1");
    expect(scoped).toContain('id="sq1-clip-a"');
    expect(scoped).toContain('id="sq1-g1"');
    expect(scoped).toContain("url(#sq1-clip-a)");
    expect(scoped).toContain("url(#sq1-g1)");
    expect(scoped).toContain('href="#sq1-clip-a"');
    expect(scoped).not.toMatch(/"#(clip-a|g1)"/);
  });
  test("leaves colours and foreign references alone", () => {
    const svg = `<svg><path fill="#ff00aa" stroke="#0f0"/></svg>`;
    expect(scopeSvgIds(svg, "sq2")).toBe(svg);
  });
  test("two scopes of one svg share no id", () => {
    const svg = renderMascot(HOUSE_MASCOT, "idle", 32);
    const a = scopeSvgIds(svg, "sqA");
    const b = scopeSvgIds(svg, "sqB");
    expect(a).not.toBe(b);
    expect(a).toMatch(/id="sqA-/);
    expect(b).toMatch(/id="sqB-/);
  });
});
