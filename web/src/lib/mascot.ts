/**
 * Squishmoji mascots (`@usespaceui/squishmoji`), per the MythCortex custom-agents contract
 * (docs/custom-agents-contract.md §11.3): every agent and bot carries a deterministic SPEC —
 * seed, shape, expression, background_style, name, personality — clamped to the library
 * catalog. The spec is data, never pixels: the client renders it fresh on every paint.
 *
 * Run state maps to an expression, so a face reacts to what its bot is really doing:
 *
 *   idle      → the spec's own (stored) expression
 *   thinking  → curious
 *   tool      → determined
 *   success   → happy
 *   error     → sad
 *   waiting   → attentive
 */
import {
  BACKGROUND_STYLE_VALUES,
  EXPRESSION_VALUES,
  SHAPE_VALUES,
  createAvatar,
  type SquishBackgroundStyleChoice,
  type SquishExpressionChoice,
  type SquishShapeChoice,
} from "@usespaceui/squishmoji";
import type { SessionStatus } from "./types";

export type AgentMascotState = "idle" | "thinking" | "tool" | "success" | "error" | "waiting";

/** `null` keeps the spec's stored expression: idle means "as designed", not a different face. */
export const STATE_EXPRESSION: Record<AgentMascotState, SquishExpressionChoice | null> = {
  idle: null,
  thinking: "curious",
  tool: "determined",
  success: "happy",
  error: "sad",
  waiting: "attentive",
};

/** The mascot spec, exactly as the contract stores it on an AgentDefinition. */
export interface MascotSpec {
  seed: string;
  shape: SquishShapeChoice;
  expression: SquishExpressionChoice;
  background_style: SquishBackgroundStyleChoice;
  name: string;
  personality: string;
}

const inCatalog = <T>(value: unknown, values: readonly T[]): T | "all" => (values.includes(value as T) ? (value as T) : "all");

/** Anything outside the catalog becomes `"all"`: a seed-driven pick from the library. */
export function clampMascotSpec(spec: Partial<MascotSpec> | null | undefined, fallbackSeed: string): MascotSpec {
  return {
    seed: typeof spec?.seed === "string" && spec.seed.trim() ? spec.seed : fallbackSeed,
    shape: inCatalog(spec?.shape, SHAPE_VALUES),
    expression: inCatalog(spec?.expression, EXPRESSION_VALUES),
    background_style: inCatalog(spec?.background_style, BACKGROUND_STYLE_VALUES),
    name: typeof spec?.name === "string" ? spec.name : "",
    personality: typeof spec?.personality === "string" ? spec.personality : "",
  };
}

/** FNV-1a: one stable number from an id, so a derived spec survives reloads (same id, same face). */
const hash = (text: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/**
 * A deterministic spec for anything that has no stored one yet (a fresh agent, a bot pane):
 * the id is the seed, the catalog picks derive from it. Same id after a reload, same mascot.
 */
export function mascotSpecFor(id: string, name = ""): MascotSpec {
  const h = hash(id);
  return clampMascotSpec(
    {
      seed: id,
      shape: SHAPE_VALUES[h % SHAPE_VALUES.length],
      expression: EXPRESSION_VALUES[(h >>> 7) % EXPRESSION_VALUES.length],
      background_style: BACKGROUND_STYLE_VALUES[(h >>> 13) % BACKGROUND_STYLE_VALUES.length],
      name,
      personality: "",
    },
    id,
  );
}

/** The one squishmoji SVG for a spec in a state, rendered in the client at `size` px. */
export function renderMascot(spec: MascotSpec, state: AgentMascotState, size: number): string {
  return createAvatar(spec.seed, {
    shape: spec.shape,
    expression: STATE_EXPRESSION[state] ?? spec.expression,
    backgroundStyle: spec.background_style,
    size,
    format: "json",
  }).svg;
}

/**
 * squishmoji derives its `<defs>` ids from seed + look, NOT per instance: the same mascot twice
 * on one page (an agent and its bot, header and sidebar) had colliding `url(#…)` references and
 * every copy but the first lost its body. This suffixes every id in the markup — and every
 * `#id` reference to one — so each render owns its own defs.
 */
export function scopeSvgIds(svg: string, scope: string): string {
  const ids = new Map<string, string>();
  const scoped = svg.replace(/\sid="([^"]+)"/g, (_m, id: string) => {
    const next = `${scope}-${id}`;
    ids.set(id, next);
    return ` id="${next}"`;
  });
  return scoped.replace(/#([A-Za-z_][\w:.-]*)/g, (m, id: string) => {
    const next = ids.get(id);
    return next ? `#${next}` : m;
  });
}

/** A session's state: the state IS the status. A bot with no session idles. */
export const statusState = (status: SessionStatus | null): AgentMascotState =>
  status === "running" ? "thinking" : status === "done" ? "success" : status === "error" || status === "interrupted" ? "error" : "idle";

/** The sidebar's status line, in words (the dot carries it too). */
export const statusLine = (status: SessionStatus): string =>
  status === "running" ? "Working…" : status === "done" ? "Finished" : status === "error" ? "Hit a snag" : status === "interrupted" ? "Interrupted" : "Online";

/** The house mascot in the brand row: one fixed spec, always the same face. */
export const HOUSE_MASCOT: MascotSpec = mascotSpecFor("mini-tui", "mini-tui");
