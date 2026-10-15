/**
 * Generative UI protocol (v4-E): the model emits a ```ui-component fenced JSON
 * block in its reply — from its final text or from anything a tool prints into
 * it — and the server turns it into a first-class `ui-component` transcript
 * event the browser renders with a native Svelte template.
 *
 * The template set is CLOSED and validated twice: here (shape, so a malformed
 * block never reaches the transcript as a component) and in the browser
 * (web/src/lib/ui/validate.ts, strict per-template props — nothing is ever
 * evaluated, no raw HTML is rendered). A block that does not parse, or names a
 * template outside the set, degrades to a `__fallback__` spec the browser shows
 * as a quiet notice instead of dropping the bot's intent silently.
 *
 * Docs for the bot runtime: docs/ui-components.md.
 */

export const UI_TEMPLATES = ["form", "chart", "table", "card", "list", "gallery", "progress"] as const;
export type UiTemplate = (typeof UI_TEMPLATES)[number];

export interface UiSpec {
  template: string;
  props: Record<string, unknown>;
}

/** One ```ui-component …``` fence. Tolerant about leading spaces and \r\n. */
const FENCE = /```\s*ui-component[ \t]*\r?\n([\s\S]*?)```/g;

/** How many components one message may carry: a transcript, not a dashboard. */
export const UI_MAX_PER_MESSAGE = 4;

function fallback(reason: string, detail?: string, requested?: string): UiSpec {
  return { template: "__fallback__", props: { reason, detail: detail ?? "", ...(requested ? { requested } : {}) } };
}

/**
 * Pull every ui-component fence out of `text`. Returns the text without the
 * fences (whitespace-collapsed where they were) and the specs in order.
 */
export function extractUiComponents(text: string): { text: string; specs: UiSpec[] } {
  if (!text || !text.includes("```")) return { text, specs: [] };
  const specs: UiSpec[] = [];
  const clean = text.replace(FENCE, (whole, body: string) => {
    if (specs.length >= UI_MAX_PER_MESSAGE) return "";
    specs.push(parseSpec(body));
    return "";
  });
  return { text: clean.replace(/\n{3,}/g, "\n\n").trimEnd(), specs };
}

function parseSpec(body: string): UiSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch (error) {
    return fallback("json", (error as Error).message.slice(0, 140));
  }
  if (typeof parsed !== "object" || parsed === null) return fallback("shape", "no es un objeto");
  const { template, props } = parsed as { template?: unknown; props?: unknown };
  if (typeof template !== "string" || !template) return fallback("shape", "falta template");
  if (props !== undefined && (typeof props !== "object" || props === null || Array.isArray(props))) {
    return fallback("shape", "props no es un objeto");
  }
  if (!(UI_TEMPLATES as readonly string[]).includes(template)) return fallback("template", template, template);
  return { template, props: (props ?? {}) as Record<string, unknown> };
}
