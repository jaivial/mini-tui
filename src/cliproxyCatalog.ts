/**
 * Which `cliproxy/` ids the local gateway actually serves.
 *
 * cli-proxy advertises its catalog on `/v1/models`, and the ids it lists is the truth about what a
 * `cliproxy/` run can use: when a subscription behind the gateway signs out, its models vanish
 * from that list while mini-tui's picker still offers them. Asking for one then fails with
 * `auth_unavailable`, which names the gateway's internals rather than the cause, so the picker
 * reads the catalog and says "not served" instead of letting a run fail.
 *
 * More than one cli-proxy can run on the same host (one per Claude subscription), plus the merge
 * proxy that fronts them all, so the gateway is picked by the model-name prefix:
 *
 *   cliproxy/        first Claude subscription   (cli-proxy-api,      :8317)
 *   cliproxy2/       second Claude subscription  (cli-proxy-api-2,    :8318)
 *   cliproxy-merge/  the merge proxy in front of them (claude-merge-proxy, :9112)
 *
 * Each gateway keeps its own base/key environment variables.
 */

import { loadConnections, modelEnv } from "./providers";

export interface CliproxyGateway {
  /** Model-name prefix mini uses for this gateway (`cliproxy/`). */
  prefix: string;
  /** Env var that points at the gateway. */
  baseEnv: string;
  /** Env var that carries the client key. */
  keyEnv: string;
  /** Where the gateway listens when nothing overrides it. */
  defaultBase: string;
  /** The key mini assumes when nothing provides one. */
  defaultKey: string;
}

export const CLIPROXY_GATEWAYS: CliproxyGateway[] = [
  {
    prefix: "cliproxy/",
    baseEnv: "CLIPROXY_API_BASE",
    keyEnv: "CLIPROXY_API_KEY",
    defaultBase: "http://127.0.0.1:8317/v1",
    defaultKey: "sk-cliproxy-local-2026",
  },
  {
    prefix: "cliproxy2/",
    baseEnv: "CLIPROXY2_API_BASE",
    keyEnv: "CLIPROXY2_API_KEY",
    defaultBase: "http://127.0.0.1:8318/v1",
    defaultKey: "sk-cliproxy2-local-2026",
  },
  {
    prefix: "cliproxy-merge/",
    baseEnv: "CLIPROXY_MERGE_API_BASE",
    keyEnv: "CLIPROXY_MERGE_API_KEY",
    defaultBase: "http://127.0.0.1:9112/v1",
    defaultKey: "sk-cliproxy-merge-local-2026",
  },
];

/** The gateway a model name belongs to, or null when it is not a cli-proxy model. */
export function cliproxyGatewayFor(model: string): CliproxyGateway | null {
  const lower = model.toLowerCase();
  return CLIPROXY_GATEWAYS.find((gateway) => lower.startsWith(gateway.prefix)) ?? null;
}

/**
 * The env a `cliproxy/` run gets: the process env, with the connection saved by `/connect` (its
 * key and base) on top, the same way `modelEnv` hands it to a run. Probing with the process env
 * alone used the built-in default key, which the gateway rejects (401) as soon as `/connect`
 * stored the real one: the doctor reported a broken key and the picker an unreachable gateway
 * while runs were fine.
 *
 * Every gateway's connection is merged, not just the first one's: each one uses its own
 * environment variables, so they do not overwrite each other.
 */
export function cliproxyEnv(env: NodeJS.ProcessEnv = process.env, connections = loadConnections()): NodeJS.ProcessEnv {
  const saved: Record<string, string> = {};
  for (const gateway of CLIPROXY_GATEWAYS) {
    const prefix = gateway.prefix.replace(/\/$/, "");
    Object.assign(saved, modelEnv(`${prefix}/probe`, connections.filter((c) => c.prefix === prefix)));
  }
  // An explicit variable in the environment still wins: it is what an operator set on purpose.
  return { ...env, ...Object.fromEntries(Object.entries(saved).filter(([k]) => !env[k])) };
}

/** mini's model name -> the bare id the gateway knows (`cliproxy/x` -> `x`). */
export function bareCliproxyId(model: string): string {
  const gateway = cliproxyGatewayFor(model);
  return gateway ? model.slice(gateway.prefix.length) : model;
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
export function cliproxyBase(env: NodeJS.ProcessEnv = process.env, gateway: CliproxyGateway = CLIPROXY_GATEWAYS[0]): string {
  return env[gateway.baseEnv] || gateway.defaultBase;
}

function apiKey(env: NodeJS.ProcessEnv, gateway: CliproxyGateway = CLIPROXY_GATEWAYS[0]): string {
  return env[gateway.keyEnv] || gateway.defaultKey;
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
    .map((row) => (row && typeof row === "object" ? (row as { id?: string }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** The gateway's catalog, or `ids: null` when it cannot be reached (never throws). */
export async function loadCliproxyCatalog(
  env: NodeJS.ProcessEnv = cliproxyEnv(),
  gateway: CliproxyGateway = CLIPROXY_GATEWAYS[0],
): Promise<CliproxyCatalog> {
  const base = cliproxyBase(env, gateway);
  try {
    return { base, ids: await fetchCatalog(base, apiKey(env, gateway)), source: "live" };
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
 * The same catalog, read synchronously (the web app renders its model list without awaiting).
 * The key goes in through stdin (`-H @-`), not argv: a key in argv is in `ps` for everyone.
 */
export function loadCliproxyCatalogSync(
  env: NodeJS.ProcessEnv = cliproxyEnv(),
  gateway: CliproxyGateway = CLIPROXY_GATEWAYS[0],
): CliproxyCatalog {
  const base = cliproxyBase(env, gateway);
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const result = spawnSync(
    "curl",
    ["-sS", "--max-time", "3", "-H", "@-", `${base.replace(/\/$/, "")}/models`],
    { encoding: "utf8", timeout: 5000, input: `Authorization: Bearer ${apiKey(env, gateway)}\n` },
  );
  try {
    const data = JSON.parse(result.stdout || "null") as { data?: Array<{ id?: unknown }> };
    const rows = Array.isArray(data?.data) ? data.data : [];
    const ids = rows
      .map((row) => (row && typeof row === "object" ? (row as { id?: string }).id : undefined))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (!ids.length) throw new Error("no ids in /v1/models");
    return { base, ids, source: "live" };
  } catch (error) {
    return { base, ids: null, source: "unreachable", error: (error as Error).message };
  }
}

/** Every gateway's catalog, keyed by prefix: the picker needs one per gateway. */
export function loadAllCliproxyCatalogs(
  env: NodeJS.ProcessEnv = cliproxyEnv(),
): Record<string, CliproxyCatalog> {
  const out: Record<string, CliproxyCatalog> = {};
  for (const gateway of CLIPROXY_GATEWAYS) out[gateway.prefix] = loadCliproxyCatalogSync(env, gateway);
  return out;
}
