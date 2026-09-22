import type { ProviderDef } from "./providers";

export type ConnectStep =
  | { kind: "provider"; index: number }
  | { kind: "key"; def: ProviderDef; value: string }
  | { kind: "models"; def: ProviderDef; key: string; models: string[]; query: string; index: number; error?: string }
  | { kind: "testing"; def: ProviderDef; key: string; model: string }
  | { kind: "done"; def: ProviderDef; model: string; count: number }
  | { kind: "error"; message: string };

/** Case-insensitive substring filter over catalog model ids. */
export function filterModels(models: string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return models;
  return models.filter((model) => model.toLowerCase().includes(needle));
}

/**
 * Window of items to display around the selection (lists never overflow the panel).
 * Indices always refer to the full `items` array.
 */
export function visibleSlice<T>(items: T[], index: number, budget: number): { start: number; items: T[] } {
  const start = Math.max(0, Math.min(index - Math.floor(budget / 2), Math.max(0, items.length - budget)));
  return { start, items: items.slice(start, start + budget) };
}
