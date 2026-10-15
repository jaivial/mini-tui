/**
 * v6-C: the candidate set, built from what is actually connected, priced and rated.
 *
 * Three inputs, three different kinds of truth, and the router must not blur them:
 *
 * - **the catalog** (v6-A, `config/model-catalog.json`) is the only source of an
 *   intelligence index, a price and a context tier. It marks what it could not
 *   source as the literal string `"desconocido"`, and that string is **unknown,
 *   not zero and not average**: 28 of the 62 models have no index, so a router
 *   that quietly scored them mid-table would be inventing the very number it
 *   claims to rank by.
 * - **the connections** say what can be called at all. A model nobody has a key
 *   for is not a candidate — picking it would be a confident answer to a call
 *   that cannot happen.
 * - **the usage ledger** (v6-B) says what a provider has recently cost in
 *   tokens, money, failures and latency. This is measurement, never a guess.
 *
 * A candidate therefore always carries *why it is here*: an `indexKnown` flag
 * that decides whether the index may be used as a ranking signal at all, and the
 * `unknowns` list that names every field nobody sourced, so the audit says
 * "unknown" instead of quietly inventing a plausible number.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { loadConnections, type SavedConnection } from "../providers";

/** USD per 1M tokens, blended 3:1 input:output — the number a ranking can compare. */
export interface Price {
  input: number;
  output: number;
}

export interface ContextTier {
  /** Parsed token ceiling, or null when the catalog says nothing usable. */
  maxTokens: number | null;
  /** The catalog's own wording, kept for the audit (`≤200K tokens`, `legacy`…). */
  label: string;
}

export interface Candidate {
  /** Catalog/connection id, provider-prefixed (`zai/glm-5.3-flash`). */
  id: string;
  provider: string;
  /** The id the API wants after the provider prefix is stripped. */
  apiModelId: string;
  displayName: string;
  /** Artificial Analysis Intelligence Index, or null when the catalog did not source one. */
  intelligenceIndex: number | null;
  /** Provenance of the index: the index is a third-party number and says which version. */
  indexSource: string;
  price: Price | null;
  context: ContextTier;
  /** Whether a saved connection can actually call this model. */
  available: boolean;
  /** Every field nobody sourced, by name — the audit's "we do not know this". */
  unknowns: string[];
}

export interface CatalogModel {
  modelId: string;
  provider: string;
  priceIn: unknown;
  priceOut: unknown;
  intelligenceIndex: number | null;
  indexSource: string;
  contextTier: string;
  displayName: string;
}

export interface ProviderRule {
  /** The HTTP status, or null when the rule is about a transport failure instead. */
  httpStatus: number | null;
  /** A stable id for a non-status rule (`connection-refused`), else the label. */
  key: string;
  label: string;
  providers: string[];
  retry: string;
  action: string;
  meaning?: string;
}

export interface ModelCatalog {
  loaded: boolean;
  path: string;
  models: CatalogModel[];
  providers: Array<{ prefix: string; displayName: string; billing: string }>;
  errorFallbackRules: ProviderRule[];
}

const EMPTY_CATALOG: ModelCatalog = { loaded: false, path: "", models: [], providers: [], errorFallbackRules: [] };

/** The catalog's own unknown marker. Anything else non-numeric is unknown too. */
export function isUnknown(value: unknown): boolean {
  return typeof value !== "number" || !Number.isFinite(value);
}

/**
 * A number, or null. The catalog's `"desconocido"` and every other non-numeric
 * form land here and stay null: `Number("desconocido")` is NaN, and a sloppy
 * `|| 0` would turn "we do not know this model's price" into "this model is
 * free", which is the one claim a router must never make.
 */
function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * The context ceiling in tokens, or null. The catalog writes tiers in prose
 * (`≤200K tokens`, `>200K tokens`, `legacy`, `off-peak`), so only an explicit
 * number is read; `legacy` and `off-peak` are not numbers and must not become
 * "no limit" either — they mean the tier is not comparable.
 */
function parseContextTier(raw: unknown): ContextTier {
  const label = typeof raw === "string" ? raw.trim() : "";
  if (!label) return { maxTokens: null, label: "desconocido" };
  const k = /(\d+(?:\.\d+)?)\s*([kKmM])\b/.exec(label);
  if (!k) return { maxTokens: null, label };
  const base = Number(k[1]);
  if (!Number.isFinite(base) || base <= 0) return { maxTokens: null, label };
  return { maxTokens: Math.round(base * (/k/i.test(k[2]!) ? 1_000 : 1_000_000)), label };
}

/** A display name from a model id: `glm-5.3-flash` → `GLM 5.3 Flash`. */
export function displayNameOf(id: string): string {
  const bare = id.slice(id.lastIndexOf("/") + 1);
  return bare
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => (/^\d/.test(part) ? part : part.toUpperCase()))
    .join(" ");
}

function parseCatalog(raw: unknown): ModelCatalog {
  if (!raw || typeof raw !== "object") return EMPTY_CATALOG;
  const root = raw as Record<string, unknown>;
  const providers: ModelCatalog["providers"] = [];
  const models: CatalogModel[] = [];
  const rows = Array.isArray(root.providers) ? root.providers : [];
  for (const entry of rows) {
    if (!entry || typeof entry !== "object") continue;
    const provider = entry as Record<string, unknown>;
    const prefix = typeof provider.prefix === "string" ? provider.prefix : typeof provider.provider === "string" ? provider.provider : "";
    if (!prefix) continue;
    providers.push({
      prefix,
      displayName: typeof provider.displayName === "string" ? provider.displayName : prefix,
      billing: typeof provider.billing === "string" ? provider.billing : "",
    });
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      if (!model || typeof model !== "object") continue;
      const row = model as Record<string, unknown>;
      const modelId = typeof row.modelId === "string" ? row.modelId : "";
      if (!modelId) continue;
      const index = row.intelligenceIndex;
      const indexRecord = index && typeof index === "object" ? (index as Record<string, unknown>) : undefined;
      const indexValue = indexRecord ? numeric(indexRecord.value) : numeric(index);
      const priceIn = numeric(row.priceIn);
      const priceOut = numeric(row.priceOut);
      const contextTier = typeof row.contextTier === "string" ? row.contextTier : "";
      models.push({
        modelId,
        provider: prefix,
        priceIn: index === undefined ? undefined : priceIn,
        priceOut: index === undefined ? undefined : priceOut,
        intelligenceIndex: indexValue,
        indexSource: typeof indexRecord?.source === "string" ? indexRecord.source : "",
        contextTier,
        displayName: displayNameOf(modelId),
      });
    }
  }
  const rules: ProviderRule[] = [];
  for (const rule of Array.isArray(root.errorFallbackRules) ? root.errorFallbackRules : []) {
    if (!rule || typeof rule !== "object") continue;
    const row = rule as Record<string, unknown>;
    const status = numeric(row.httpStatus);
    const label = typeof row.label === "string" ? row.label : "";
    // A rule with no numeric status is still a rule: the catalog documents
    // `connection-refused` and `ollama-not-running` as transport failures, which
    // are exactly what the breaker must recognise. Dropping them would lose two
    // of the thirteen, so the raw status is kept as the rule's key.
    const raw = typeof row.httpStatus === "string" ? row.httpStatus : "";
    if (status === null && !raw && !label) continue;
    rules.push({
      httpStatus: status,
      key: status === null ? raw || label : String(status),
      label: label || raw || String(status),
      providers: Array.isArray(row.providers) ? row.providers.filter((p): p is string => typeof p === "string") : [],
      retry: typeof row.retry === "string" ? row.retry : "",
      action: typeof row.action === "string" ? row.action : "",
      ...(typeof row.meaning === "string" ? { meaning: row.meaning } : {}),
    });
  }
  return { loaded: models.length > 0, path: "", models, providers, errorFallbackRules: rules };
}

export function catalogPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MINITUI_MODEL_CATALOG) return env.MINITUI_MODEL_CATALOG;
  return join(import.meta.dir, "..", "..", "config", "model-catalog.json");
}

/** Cached on the file's mtime+size: a parse on every decision would cost more than the decision. */
const cache = new Map<string, { stamp: string; catalog: ModelCatalog }>();

export function loadCatalog(path: string = catalogPath()): ModelCatalog {
  let stamp = "";
  try {
    const st = statSync(path);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    return { ...EMPTY_CATALOG, path };
  }
  const hit = cache.get(path);
  if (hit && hit.stamp === stamp) return hit.catalog;
  let catalog: ModelCatalog;
  try {
    catalog = { ...parseCatalog(JSON.parse(readFileSync(path, "utf8"))), path };
  } catch {
    catalog = { ...EMPTY_CATALOG, path };
  }
  cache.set(path, { stamp, catalog });
  return catalog;
}

export function resetCatalogCache(): void {
  cache.clear();
}

/** Every id the saved connections can actually call, mapped to its connection. */
export function connectedModelIds(connections: SavedConnection[] = loadConnections()): Map<string, SavedConnection> {
  const out = new Map<string, SavedConnection>();
  for (const connection of connections) {
    for (const model of connection.models ?? []) {
      const qualified = model.includes("/") ? model : `${connection.prefix}/${model}`;
      if (!out.has(qualified)) out.set(qualified, connection);
    }
  }
  return out;
}

/**
 * The candidate pool.
 *
 * `catalogOnly` returns every catalogued model, connected or not — what the
 * Settings panel shows so the operator can see what the router *could* reach.
 * The router itself always calls with connections, so a pool of zero means
 * "no keys": the router then says so out loud instead of picking something the
 * house cannot run.
 */
export function buildCandidates(options: { catalogOnly?: boolean; connections?: SavedConnection[] } = {}): Candidate[] {
  const catalog = loadCatalog();
  const connected = options.catalogOnly ? new Map<string, SavedConnection>() : connectedModelIds(options.connections);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const row of catalog.models) {
    if (seen.has(row.modelId)) continue;
    seen.add(row.modelId);
    // The same model id can appear twice with different context tiers (grok-4.7 at
    // ≤200K and >200K). They are one model to call, so the first row wins and
    // the rest are dropped — a duplicate in the pool would double every weight.
    const unknowns: string[] = [];
    const priceIn = numeric(row.priceIn);
    const priceOut = numeric(row.priceOut);
    if (priceIn === null || priceOut === null) unknowns.push("price");
    if (row.intelligenceIndex === null) unknowns.push("intelligenceIndex");
    const context = parseContextTier(row.contextTier);
    if (context.maxTokens === null) unknowns.push("contextTier");
    out.push({
      id: row.modelId,
      provider: row.provider,
      apiModelId: row.modelId.slice(row.provider.length + 1) || row.modelId,
      displayName: row.displayName,
      intelligenceIndex: row.intelligenceIndex,
      indexSource: row.indexSource,
      price: priceIn !== null && priceOut !== null ? { input: priceIn, output: priceOut } : null,
      context,
      available: connected.has(row.modelId),
      unknowns,
    });
  }
  return out;
}