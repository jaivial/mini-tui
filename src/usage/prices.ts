/**
 * v6-B: token prices, read from the v6-A catalog (`config/model-catalog.json`).
 *
 * The catalog is optional by design: v6-A may not have landed yet, and a missing
 * or unreadable catalog must never stop a run. So a lookup miss is `null`, which
 * the store records as "unknown cost" — never 0, because a zero price is a claim
 * that a call was free, and nobody has established that.
 *
 * The real catalog shape (v6-A, `catalogVersion: 1`) is
 * `providers[] { prefix, models[] { modelId, priceIn, priceOut, priceCacheRead,
 * priceCacheWrite } }`, USD per 1M tokens, where **an unknown price is the literal
 * string `"desconocido"`** — the catalog's own `unknownValue`, and 26 of the 62
 * models use it for at least one direction. So a price direction counts as known
 * only when it is a finite number; the string never becomes 0. A model missing
 * either direction is not priceable at all.
 *
 * Two looser shapes are also accepted so this keeps working if the catalog is
 * ever flattened: `{ models: { "<provider>/<id>": {...} } }` and
 * `{ models: [{ provider, id, ... }] }`.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-read tokens. */
  cacheRead: number;
  /** USD per 1M cache-write tokens. */
  cacheWrite: number;
}

export function catalogPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MINITUI_MODEL_CATALOG) return env.MINITUI_MODEL_CATALOG;
  // <repo>/config/model-catalog.json, wherever the running build lives.
  return join(import.meta.dir, "..", "..", "config", "model-catalog.json");
}

/**
 * A price direction, or null when the catalog says it is unknown.
 *
 * The only accepted numeric form is a finite, non-negative number. The string
 * `"desconocido"` (and anything else non-numeric) is deliberately *not* coerced:
 * `Number("desconocido")` is NaN and a sloppy `|| 0` would turn "we do not know
 * this" into "this is free", which is the exact claim this module must never make.
 */
function numberAt(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    // A catalog that quotes its prices as numeric strings is still usable; the
    // unknown marker is not a number, so it fails this test too.
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      const parsed = Number(value);
      if (parsed >= 0) return parsed;
    }
  }
  return null;
}

/** Accepts the v6-A field names and the flatter aliases. */
function parsePrice(raw: unknown): ModelPrice | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const input = numberAt(source, ["priceIn", "input", "inputPerMillion", "input_per_million", "prompt"]);
  const output = numberAt(source, ["priceOut", "output", "outputPerMillion", "output_per_million", "completion"]);
  // A row without both directions cannot price a call: half a price is not a price.
  if (input === null || output === null) return null;
  return {
    input,
    output,
    cacheRead: numberAt(source, ["priceCacheRead", "cacheRead", "cache_read", "cacheReadPerMillion"]) ?? 0,
    cacheWrite: numberAt(source, ["priceCacheWrite", "cacheWrite", "cache_write", "cacheWritePerMillion"]) ?? 0,
  };
}

/**
 * Index a parsed catalog by every key a model might arrive under: the full
 * `provider/id` and the bare `id`. OpenRouter-style ids contain slashes
 * (`anthropic/claude-sonnet-4.5`), so the bare form is the last segment.
 */
function indexCatalog(parsed: unknown): Map<string, ModelPrice> {
  const out = new Map<string, ModelPrice>();
  const add = (key: string, price: ModelPrice | null) => {
    if (!price) return;
    out.set(key, price);
    const bare = key.slice(key.lastIndexOf("/") + 1);
    // A bare id already taken is left alone: the qualified key is the more precise one.
    if (bare !== key && !out.has(bare)) out.set(bare, price);
  };
  // v6-A's real shape: providers[] each carrying a models[] list.
  const providers = (parsed as { providers?: unknown })?.providers;
  if (Array.isArray(providers)) {
    for (const entry of providers) {
      if (!entry || typeof entry !== "object") continue;
      const provider = entry as Record<string, unknown>;
      const prefix = typeof provider.prefix === "string" ? provider.prefix : typeof provider.provider === "string" ? provider.provider : "";
      const models = provider.models;
      if (!Array.isArray(models)) continue;
      for (const model of models) {
        if (!model || typeof model !== "object") continue;
        const row = model as Record<string, unknown>;
        const id = typeof row.modelId === "string" ? row.modelId : typeof row.id === "string" ? row.id : "";
        if (!id) continue;
        add(prefix && !id.startsWith(`${prefix}/`) ? `${prefix}/${id}` : id, parsePrice(row));
      }
    }
    if (out.size) return out;
  }
  const rows = (parsed as { models?: unknown })?.models;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const entry = row as Record<string, unknown>;
      const provider = typeof entry.provider === "string" ? entry.provider : "";
      const id = typeof entry.id === "string" ? entry.id : typeof entry.model === "string" ? entry.model : typeof entry.modelId === "string" ? entry.modelId : "";
      if (!id) continue;
      add(provider && !id.startsWith(`${provider}/`) ? `${provider}/${id}` : id, parsePrice(entry));
    }
    return out;
  }
  if (rows && typeof rows === "object") {
    for (const [key, value] of Object.entries(rows as Record<string, unknown>)) add(key, parsePrice(value));
  }
  return out;
}

export interface PriceCatalog {
  /** Whether a catalog file was found and parsed. False = every cost is unknown. */
  loaded: boolean;
  /** Where it was read from, for the panel's "prices from" line. */
  path: string;
  /** Model keys known, for display. */
  models: number;
  /** Look up a price by model (`provider/id` or bare id). Null when unknown. */
  price(model: string): ModelPrice | null;
}

const EMPTY: PriceCatalog = { loaded: false, path: "", models: 0, price: () => null };

/**
 * Read the catalog, cached on its mtime so the price lookup on the hot path
 * (every model call) is a stat, not a parse. A missing file is a normal state.
 */
export function loadPriceCatalog(path: string = catalogPath(), now = Date.now()): PriceCatalog {
  let stamp = -1;
  try {
    stamp = statSync(path).mtimeMs;
  } catch {
    return { ...EMPTY, path };
  }
  const cacheKey = `${path}:${stamp}:${now}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  let table = new Map<string, ModelPrice>();
  try {
    table = indexCatalog(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    table = new Map(); // malformed catalog: unknown prices, never invented ones
  }
  const catalog: PriceCatalog = {
    loaded: table.size > 0,
    path,
    models: table.size,
    price(model: string) {
      const key = model.trim();
      return table.get(key) ?? table.get(key.slice(key.lastIndexOf("/") + 1)) ?? null;
    },
  };
  if (cache.size > 8) cache.clear();
  cache.set(cacheKey, catalog);
  return catalog;
}

const cache = new Map<string, PriceCatalog>();

/** Drop the cached catalogs (tests, and a long-lived server that must see a new file). */
export function resetPriceCatalogCache(): void {
  cache.clear();
}

/** True when the catalog file is there at all — the panel's "prices configured" line. */
export function catalogExists(path: string = catalogPath()): boolean {
  return existsSync(path);
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * USD for a call from a price row, or null when the price is unknown. A call with
 * no tokens at all still has a cost of 0 *if* it is priced — but an unpriced model
 * stays null, because "we could not price it" and "it was free" are different facts.
 *
 * Cached tokens are subtracted from the input count before pricing: a provider
 * reports them *inside* `prompt_tokens` and separately in the cache detail, so
 * billing both would charge the same tokens twice. This matches how the agent's
 * own price table treats the same numbers (`models/prices.rs`). The stored row
 * keeps the provider's full input count, so the tokens column stays truthful.
 */
export function costFor(price: ModelPrice | null, tokens: TokenCounts): number | null {
  if (!price) return null;
  const billableInput = Math.max(0, tokens.input - tokens.cacheRead);
  const usd =
    (billableInput * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite * price.cacheWrite) /
    1_000_000;
  if (!Number.isFinite(usd)) return null;
  return Math.round(usd * 1e6) / 1e6;
}