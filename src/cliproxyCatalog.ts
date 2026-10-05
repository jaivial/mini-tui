/**
 * Which `cliproxy/` ids the local gateway actually serves.
 *
 * cli-proxy advertises its catalog on `/v1/models`, and the ids it lists is the truth about what a
 * `cliproxy/` run can use: when a subscription behind the gateway signs out, its models vanish
 * from that list while mini-tui's picker still offers them. Asking for one then fails with
 * `auth_unavailable`, which names the gateway's internals rather than the cause, so the picker
 * reads the catalog and says "not served" instead of letting a run fail.
 */

const CLIPROXY_PREFIX = "cliproxy/";

/** mini's model name -> the bare id the gateway knows (`cliproxy/x` -> `x`). */
export function bareCliproxyId(model: string): string {
  return model.toLowerCase().startsWith(CLIPROXY_PREFIX) ? model.slice(CLIPROXY_PREFIX.length) : model;
}

export interface CliproxyCatalog {
  base: string;
  /** Every id the gateway advertises, or null when it could not be reached. */
  ids: string[] | null;
  /** How the list was obtained (`live` or `unreachable`). */
  source: "live" | "unreachable";
  error?: string;
}

/** The gateway's base URL, the way the agent resolves it (`CLIPROXY_API_BASE`, else the default). */
export function cliproxyBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLIPROXY_API_BASE || "http://127.0.0.1:8317/v1";
}

function apiKey(env: NodeJS.ProcessEnv): string {
  return env.CLIPROXY_API_KEY || "sk-cliproxy-local-2026";
}

async function fetchCatalog(base: string, key: string): Promise<string[]> {
  const response = await fetch(`${base.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${key}`, "x-api-key": key },
    // A picker must never hang on a gateway that is down: fail fast into "unreachable".
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as { data?: Array<{ id?: unknown }> };
  const rows = Array.isArray(data.data) ? data.data : [];
  return rows
    .map((row) => (row && typeof row === "object" ? (row as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** The gateway's catalog, or `ids: null` when it cannot be reached (never throws). */
export async function loadCliproxyCatalog(env: NodeJS.ProcessEnv = process.env): Promise<CliproxyCatalog> {
  const base = cliproxyBase(env);
  try {
    return { base, ids: await fetchCatalog(base, apiKey(env)), source: "live" };
  } catch (error) {
    return { base, ids: null, source: "unreachable", error: (error as Error).message };
  }
}

/** Is `model` one the gateway serves? Unreachable gateway = no opinion (never blocks a pick). */
export function gatewayServes(catalog: CliproxyCatalog | null, model: string): boolean | null {
  if (!catalog || !catalog.ids) return null;
  return catalog.ids.includes(bareCliproxyId(model));
}

/**
 * Blocking variant for server-side code (`src/web/config.ts`), which answers a request and cannot
 * await. `spawnSync` keeps it off the event loop's thread; the 3 s timeout bounds a request.
 */
export function loadCliproxyCatalogSync(env: NodeJS.ProcessEnv = process.env): CliproxyCatalog {
  const base = cliproxyBase(env);
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const result = spawnSync(
    "curl",
    ["-sS", "--max-time", "3", "-H", `Authorization: Bearer ${apiKey(env)}`, `${base.replace(/\/$/, "")}/models`],
    { encoding: "utf8", timeout: 5000 },
  );
  try {
    const data = JSON.parse(result.stdout || "null") as { data?: Array<{ id?: unknown }> };
    const rows = Array.isArray(data?.data) ? data.data : [];
    const ids = rows
      .map((row) => (row && typeof row === "object" ? (row as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (!ids.length) throw new Error("no ids in /v1/models");
    return { base, ids, source: "live" };
  } catch (error) {
    return { base, ids: null, source: "unreachable", error: (error as Error).message };
  }
}
