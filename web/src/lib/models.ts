/** Pure helpers for the model switcher: grouping, search and id validation. No DOM, no Svelte. */
import type { ModelInfo } from "./types";

export interface ModelOption {
  /** What is sent to the server. */
  id: string;
  /** The id without its provider prefix: the part a person scans for. */
  name: string;
  provider: string;
  description: string;
  /** A hand-typed id that is not in the catalogue. */
  custom?: boolean;
}

export interface ModelGroup {
  provider: string;
  options: ModelOption[];
}

export function providerOf(id: string): string {
  const i = id.indexOf("/");
  return i > 0 ? id.slice(0, i) : "other";
}

export function shortName(id: string): string {
  const i = id.indexOf("/");
  return i > 0 ? id.slice(i + 1) : id;
}

/** Ids are `provider/model` style tokens. Whitespace or shell characters are never valid. */
export function isValidModelId(id: string): boolean {
  return /^[\w][\w.:@/+-]{0,127}$/.test(id.trim());
}

export function toOption(m: ModelInfo): ModelOption {
  return { id: m.id, name: shortName(m.id), provider: providerOf(m.id), description: m.description };
}

/**
 * Every whitespace-separated query token must appear somewhere in the id or description
 * (any order), so "claude 5" finds claude-sonnet-5-5 and "flash deepseek" finds either.
 */
export function matches(option: ModelOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${option.id} ${option.description}`.toLowerCase();
  return q.split(/\s+/).every((token) => hay.includes(token));
}

/**
 * Groups by provider in catalogue order. A typed id that matches nothing exactly becomes a
 * trailing "Use …" option, so a model missing from the list is never a dead end.
 * `current` is pinned into the list even if the catalogue does not know it.
 */
export function buildGroups(models: ModelInfo[], query: string, current = ""): { groups: ModelGroup[]; flat: ModelOption[] } {
  const all = models.map(toOption);
  if (current && !all.some((o) => o.id === current)) {
    all.unshift({ id: current, name: shortName(current), provider: providerOf(current), description: "Current model", custom: true });
  }
  const shown = all.filter((o) => matches(o, query));
  const groups: ModelGroup[] = [];
  for (const option of shown) {
    let group = groups.find((g) => g.provider === option.provider);
    if (!group) groups.push((group = { provider: option.provider, options: [] }));
    group.options.push(option);
  }
  const typed = query.trim();
  // A bare word that already found models is a search, not an id: offering "Use flash" beside
  // two real flash models is noise. Offer the custom row when nothing matched, or when the text
  // is shaped like `provider/model` (which a search rarely is).
  const looksLikeId = typed.includes("/") || shown.length === 0;
  if (typed && looksLikeId && isValidModelId(typed) && !all.some((o) => o.id.toLowerCase() === typed.toLowerCase())) {
    groups.push({
      provider: "Custom",
      options: [{ id: typed, name: typed, provider: "Custom", description: "Use this id as typed", custom: true }],
    });
  }
  return { groups, flat: groups.flatMap((g) => g.options) };
}

/** Next index for arrow keys, wrapping at both ends; -1 when there is nothing to move over. */
export function step(index: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return -1;
  if (index < 0) return delta === 1 ? 0 : length - 1;
  return (index + delta + length) % length;
}
