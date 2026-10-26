import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Google Business Profile as an MCP server, served by mini-tui's own web server
 * (`http://127.0.0.1:4317/api/gbp/mcp`). Google publishes no MCP server for Business Profile
 * (unlike Search Console), so this one is a thin, stateless proxy to its REST APIs.
 *
 * Authentication is Google's, not ours: an anonymous request is answered 401 with protected-resource
 * metadata naming `accounts.google.com`, so mini-tui's usual OAuth flow (your own OAuth client,
 * offline access, background refresh, reload on 401 mid-run) logs in exactly as it does for Search
 * Console. The agent then sends that Google access token as its Bearer and this server forwards it.
 * No token is stored or logged here.
 *
 * Several businesses: `~/.config/mini-tui/google-business.json` keeps the locations you saved
 * (alias → account + location) and which one is the default, so every tool takes an optional
 * `business` and the agent can switch between them.
 */

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage";
const TIMEOUT_MS = 30_000;
const MAX_TEXT = 60_000;

const API = {
  accounts: "https://mybusinessaccountmanagement.googleapis.com/v1",
  info: "https://mybusinessbusinessinformation.googleapis.com/v1",
  v4: "https://mybusiness.googleapis.com/v4",
  performance: "https://businessprofileperformance.googleapis.com/v1",
};

const LOCATION_FIELDS =
  "name,title,storeCode,languageCode,phoneNumbers,categories,storefrontAddress,websiteUri,regularHours,specialHours,moreHours,serviceArea,labels,latlng,openInfo,metadata,profile,relationshipData,serviceItems";
const LIST_FIELDS = "name,title,storeCode,storefrontAddress,websiteUri,phoneNumbers,categories.primaryCategory,metadata.placeId,metadata.mapsUri";

export const DAILY_METRICS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "BUSINESS_CONVERSATIONS",
  "BUSINESS_DIRECTION_REQUESTS",
  "CALL_CLICKS",
  "WEBSITE_CLICKS",
  "BUSINESS_BOOKINGS",
  "BUSINESS_FOOD_ORDERS",
  "BUSINESS_FOOD_MENU_CLICKS",
];

// ------------------------------------------------------------------ saved businesses

export interface SavedBusiness {
  /** Alias the agent and the user refer to it by (slug). */
  id: string;
  /** `accounts/123` */
  account: string;
  /** `locations/456` */
  location: string;
  title?: string;
  addedAt: number;
}

interface BusinessFile {
  default?: string;
  businesses: SavedBusiness[];
}

/** Null under test with no explicit path, like mcp.json: a test never touches the home. */
export function businessesPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.MINITUI_GBP_PATH) return env.MINITUI_GBP_PATH;
  if (env.NODE_ENV === "test" || env.MINITUI_TEST === "1") return null;
  return join(homedir(), ".config", "mini-tui", "google-business.json");
}

export function loadBusinesses(path: string | null = businessesPath()): BusinessFile {
  if (!path) return { businesses: [] };
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<BusinessFile>;
    const businesses = Array.isArray(data.businesses)
      ? data.businesses.filter((b): b is SavedBusiness => !!b && typeof b.id === "string" && typeof b.account === "string" && typeof b.location === "string")
      : [];
    return { businesses, ...(typeof data.default === "string" ? { default: data.default } : {}) };
  } catch {
    return { businesses: [] };
  }
}

function saveBusinesses(file: BusinessFile, path: string | null): void {
  if (!path) throw new Error("no place to save businesses (MINITUI_GBP_PATH)");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort permissions
  }
}

function slug(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** `123`, `accounts/123` → `accounts/123`; anything else is refused. */
export function resourceName(kind: "accounts" | "locations", value: unknown): string {
  const raw = String(value ?? "").trim();
  const m = raw.match(new RegExp(`^(?:.*\\b${kind}/)?([0-9]+)$`));
  if (!m) throw new ToolError(`"${raw}" is not a ${kind === "accounts" ? "account" : "location"} id (digits, or ${kind}/<digits>)`);
  return `${kind}/${m[1]}`;
}

/** The business a call is about: the alias given, else the default, else the only one saved. */
export function pickBusiness(alias: unknown, file: BusinessFile): SavedBusiness {
  const all = file.businesses;
  if (alias !== undefined && alias !== null && String(alias).trim()) {
    const want = String(alias).trim();
    const found =
      all.find((b) => b.id === want) ?? all.find((b) => b.location === want || b.location === `locations/${want}`) ?? all.find((b) => b.id === slug(want));
    if (!found) throw new ToolError(`no saved business "${want}". Saved: ${all.map((b) => b.id).join(", ") || "none (use business_add)"}`);
    return found;
  }
  const byDefault = file.default ? all.find((b) => b.id === file.default) : undefined;
  if (byDefault) return byDefault;
  if (all.length === 1) return all[0]!;
  if (!all.length) throw new ToolError("no business saved yet: find it with accounts_list + locations_list, then business_add");
  throw new ToolError(`several businesses are saved and none is the default: pass business (${all.map((b) => b.id).join(", ")}) or call business_select`);
}

// ------------------------------------------------------------------ Google calls

export class ToolError extends Error {}
/** Google refused the token itself: answered as HTTP 401 so the agent reloads a refreshed one. */
export class AuthError extends Error {}

type Fetch = typeof fetch;

async function google(fetcher: Fetch, token: string, url: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const r = await fetcher(url, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await r.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text;
  }
  if (r.ok) return data;
  const err = (data as { error?: { message?: string; status?: string; details?: unknown[] } } | undefined)?.error;
  const message = `${err?.status ?? `HTTP ${r.status}`}: ${err?.message ?? String(text).slice(0, 300)}`;
  if (r.status === 401) throw new AuthError(message);
  // 403 is not a login problem here: an API not enabled, a quota of 0 (Business Profile API
  // access not approved yet) or an account that does not manage the location.
  const hint =
    r.status === 403 || r.status === 429
      ? " (check: the API is enabled in your Google Cloud project, the project's Business Profile API access is approved (quota > 0), and this Google account manages the location)"
      : "";
  throw new ToolError(`Google answered ${message}${hint}`);
}

function query(params: Record<string, string | number | boolean | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    for (const one of Array.isArray(v) ? v : [v]) q.append(k, String(one));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

function ymd(value: unknown, label: string): { year: number; month: number; day: number } {
  const m = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new ToolError(`${label} must be YYYY-MM-DD`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function ym(value: unknown, label: string): { year: number; month: number } {
  const m = String(value ?? "").match(/^(\d{4})-(\d{2})$/);
  if (!m) throw new ToolError(`${label} must be YYYY-MM`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

function v4Path(b: SavedBusiness): string {
  return `${API.v4}/${b.account}/${b.location}`;
}

// ------------------------------------------------------------------ tools

const businessArg = { business: { type: "string", description: "Alias of a saved business (businesses_list). Omit for the default one." } };

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, ctx: Ctx) => Promise<unknown>;
}

interface Ctx {
  token: string;
  fetcher: Fetch;
  path: string | null;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });

export const TOOLS: Tool[] = [
  {
    name: "businesses_list",
    description: "The businesses saved in mini-tui (alias, account, location, title) and which one is the default. Every other tool takes `business` = one of these aliases.",
    inputSchema: obj({}),
    run: async (_a, ctx) => {
      const file = loadBusinesses(ctx.path);
      return { default: file.default ?? (file.businesses.length === 1 ? file.businesses[0]!.id : null), businesses: file.businesses };
    },
  },
  {
    name: "accounts_list",
    description: "Business Profile accounts this Google login can manage (personal, location groups, organizations). Use an account name with locations_list.",
    inputSchema: obj({ pageToken: { type: "string" } }),
    run: async (a, ctx) => google(ctx.fetcher, ctx.token, `${API.accounts}/accounts${query({ pageSize: 20, pageToken: a.pageToken as string | undefined })}`),
  },
  {
    name: "locations_list",
    description: "Locations (business profiles) of an account: name (locations/<id>), title, address, phone, website, primary category, Maps link.",
    inputSchema: obj({ account: { type: "string", description: "accounts/<id> (from accounts_list)" }, filter: { type: "string", description: "Optional, e.g. title=\"Villa Carmen\"" }, pageToken: { type: "string" } }, ["account"]),
    run: async (a, ctx) =>
      google(ctx.fetcher, ctx.token, `${API.info}/${resourceName("accounts", a.account)}/locations${query({ readMask: LIST_FIELDS, pageSize: 100, filter: a.filter as string | undefined, pageToken: a.pageToken as string | undefined })}`),
  },
  {
    name: "business_add",
    description: "Save a location as a business you can pick later (checked against Google first). The first one saved becomes the default.",
    inputSchema: obj(
      {
        account: { type: "string", description: "accounts/<id>" },
        location: { type: "string", description: "locations/<id>" },
        alias: { type: "string", description: "Short name to refer to it (default: from its title)" },
        makeDefault: { type: "boolean" },
      },
      ["account", "location"],
    ),
    run: async (a, ctx) => {
      const account = resourceName("accounts", a.account);
      const location = resourceName("locations", a.location);
      const found = (await google(ctx.fetcher, ctx.token, `${API.info}/${location}${query({ readMask: "name,title" })}`)) as { title?: string };
      const file = loadBusinesses(ctx.path);
      const id = slug(String(a.alias ?? "") || found.title || location.replace("/", "-")) || location.replace("/", "-");
      const others = file.businesses.filter((b) => b.id !== id && b.location !== location);
      const record: SavedBusiness = { id, account, location, ...(found.title ? { title: found.title } : {}), addedAt: Date.now() };
      const next: BusinessFile = { businesses: [...others, record], default: a.makeDefault || !file.default || !others.some((b) => b.id === file.default) ? id : file.default };
      saveBusinesses(next, ctx.path);
      return { saved: record, default: next.default };
    },
  },
  {
    name: "business_select",
    description: "Make a saved business the default for the calls that omit `business`.",
    inputSchema: obj({ business: { type: "string" } }, ["business"]),
    run: async (a, ctx) => {
      const file = loadBusinesses(ctx.path);
      const b = pickBusiness(a.business, file);
      saveBusinesses({ ...file, default: b.id }, ctx.path);
      return { default: b.id, business: b };
    },
  },
  {
    name: "business_remove",
    description: "Forget a saved business (nothing changes on Google).",
    inputSchema: obj({ business: { type: "string" } }, ["business"]),
    run: async (a, ctx) => {
      const file = loadBusinesses(ctx.path);
      const b = pickBusiness(a.business, file);
      const businesses = file.businesses.filter((x) => x.id !== b.id);
      const next: BusinessFile = { businesses, ...(file.default && file.default !== b.id ? { default: file.default } : businesses[0] ? { default: businesses[0].id } : {}) };
      saveBusinesses(next, ctx.path);
      return { removed: b.id, default: next.default ?? null };
    },
  },
  {
    name: "location_get",
    description: "The business profile as Google has it: title, categories, phones, address, website, regular/special/more hours, description, service area, open status, Maps/Place ids. `googleUpdated: true` returns Google's pending version (edits from users or Google) instead.",
    inputSchema: obj({ ...businessArg, readMask: { type: "string", description: `Fields (default: ${LOCATION_FIELDS})` }, googleUpdated: { type: "boolean" } }),
    run: async (a, ctx) => {
      const b = pickBusiness(a.business, loadBusinesses(ctx.path));
      const mask = (a.readMask as string | undefined) || LOCATION_FIELDS;
      return google(ctx.fetcher, ctx.token, `${API.info}/${b.location}${a.googleUpdated ? ":getGoogleUpdated" : ""}${query({ readMask: mask })}`);
    },
  },
  {
    name: "location_update",
    description:
      "WRITES the public profile. Patch only the fields named in updateMask (e.g. \"regularHours,websiteUri\", \"profile.description\", \"phoneNumbers\"). Run with validateOnly first and show the user the change before applying it.",
    inputSchema: obj(
      { ...businessArg, updateMask: { type: "string" }, location: { type: "object", description: "A Location object with the new values of the masked fields" }, validateOnly: { type: "boolean" } },
      ["updateMask", "location"],
    ),
    run: async (a, ctx) => {
      const b = pickBusiness(a.business, loadBusinesses(ctx.path));
      if (!a.location || typeof a.location !== "object") throw new ToolError("location must be an object");
      return google(ctx.fetcher, ctx.token, `${API.info}/${b.location}${query({ updateMask: String(a.updateMask), validateOnly: a.validateOnly ? true : undefined })}`, { method: "PATCH", body: a.location });
    },
  },
  {
    name: "reviews_list",
    description: "Reviews of the business, newest first, with rating, comment, reviewer display name and any reply; also the average rating and total count.",
    inputSchema: obj({ ...businessArg, pageSize: { type: "number", description: "1-50 (default 50)" }, pageToken: { type: "string" }, orderBy: { type: "string", description: "updateTime desc (default), rating, rating desc" } }),
    run: async (a, ctx) => {
      const b = pickBusiness(a.business, loadBusinesses(ctx.path));
      const size = Math.min(50, Math.max(1, Number(a.pageSize) || 50));
      return google(ctx.fetcher, ctx.token, `${v4Path(b)}/reviews${query({ pageSize: size, pageToken: a.pageToken as string | undefined, orderBy: (a.orderBy as string | undefined) || "updateTime desc" })}`);
    },
  },
  {
    name: "review_reply",
    description: "WRITES a public reply to a review (replaces an existing reply). Personal, no keyword stuffing; show the user the text before posting.",
    inputSchema: obj({ ...businessArg, review: { type: "string", description: "reviewId, or the review's full name" }, comment: { type: "string" } }, ["review", "comment"]),
    run: async (a, ctx) => {
      const b = pickBusiness(a.business, loadBusinesses(ctx.path));
      const id = String(a.review ?? "").split("/").pop()?.trim();
      const comment = String(a.comment ?? "").trim();
      if (!id || !/^[\w-]+$/.test(id)) throw new ToolError("review must be a review id");
      if (!comment) throw new ToolError("comment is empty");
      return google(ctx.fetcher, ctx.token, `${v4Path(b)}/reviews/${id}/reply`, { method: "PUT", body: { comment } });
    },
  },
  {
    name: "posts_list",
    description: "Local posts (updates, offers, events) published on the profile.",
    inputSchema: obj({ ...businessArg, pageToken: { type: "string" } }),
    run: async (a, ctx) => {
      const b = pickBusiness(a.business, loadBusinesses(ctx.path));
      return google(ctx.fetcher, ctx.token, `${v4Path(b)}/localPosts${query({ pageSize: 100, pageToken: a.pageToken as string | undefined })}`);
    },
  },
  {
    name: "post_create",
    description: "WRITES (publishes) a local post. `post` is a LocalPost: {languageCode, summary, topicType: STANDARD|EVENT|OFFER, callToAction?: {actionType: BOOK|ORDER|LEARN_MORE|CALL..., url}, media?, event?, offer?}. Confirm with the user first.",
    inputSchema: obj({ ...businessArg, post: { type: "object" } }, ["post"]),
    run: async (a, ctx) => {
      const b = pickBusiness(a.business, loadBusinesses(ctx.path));
      if (!a.post || typeof a.post !== "object") throw new ToolError("post must be an object");
      return google(ctx.fetcher, ctx.token, `${v4Path(b)}/localPosts`, { method: "POST", body: a.post });
    },
  },
  {
    name: "performance",
    description: `Daily metrics between two dates (inclusive): ${DAILY_METRICS.join(", ")}. Default: impressions (4), calls, website clicks, direction requests, bookings.`,
    inputSchema: obj({ ...businessArg, startDate: { type: "string", description: "YYYY-MM-DD" }, endDate: { type: "string", description: "YYYY-MM-DD" }, metrics: { type: "array", items: { type: "string", enum: DAILY_METRICS } } }, ["startDate", "endDate"]),
    run: async (a, ctx) => {
      const b = pickBusiness(a.business, loadBusinesses(ctx.path));
      const s = ymd(a.startDate, "startDate");
      const e = ymd(a.endDate, "endDate");
      const wanted = Array.isArray(a.metrics) && a.metrics.length ? a.metrics.map(String) : DAILY_METRICS.filter((m) => !/CONVERSATIONS|FOOD/.test(m));
      const bad = wanted.filter((m) => !DAILY_METRICS.includes(m));
      if (bad.length) throw new ToolError(`unknown metrics: ${bad.join(", ")}`);
      return google(
        ctx.fetcher,
        ctx.token,
        `${API.performance}/${b.location}:fetchMultiDailyMetricsTimeSeries${query({
          dailyMetrics: wanted,
          "dailyRange.start_date.year": s.year,
          "dailyRange.start_date.month": s.month,
          "dailyRange.start_date.day": s.day,
          "dailyRange.end_date.year": e.year,
          "dailyRange.end_date.month": e.month,
          "dailyRange.end_date.day": e.day,
        })}`,
      );
    },
  },
  {
    name: "search_keywords",
    description: "Monthly search terms that showed the profile in Search/Maps, with impressions (low counts come as a threshold).",
    inputSchema: obj({ ...businessArg, startMonth: { type: "string", description: "YYYY-MM" }, endMonth: { type: "string", description: "YYYY-MM" }, pageToken: { type: "string" } }, ["startMonth", "endMonth"]),
    run: async (a, ctx) => {
      const b = pickBusiness(a.business, loadBusinesses(ctx.path));
      const s = ym(a.startMonth, "startMonth");
      const e = ym(a.endMonth, "endMonth");
      return google(
        ctx.fetcher,
        ctx.token,
        `${API.performance}/${b.location}/searchkeywords/impressions/monthly${query({
          "monthlyRange.start_month.year": s.year,
          "monthlyRange.start_month.month": s.month,
          "monthlyRange.end_month.year": e.year,
          "monthlyRange.end_month.month": e.month,
          pageSize: 100,
          pageToken: a.pageToken as string | undefined,
        })}`,
      );
    },
  },
];

// ------------------------------------------------------------------ the MCP endpoint

export interface GbpOptions {
  /** Where the protected-resource metadata is served. */
  metadataUrl: string;
  path?: string | null;
  fetcher?: Fetch;
}

/** RFC 9728 metadata: the token comes from Google's authorization server. No `resource`: Google would not know it. */
export function protectedResourceMetadata(): Record<string, unknown> {
  return { authorization_servers: ["https://accounts.google.com/"], scopes_supported: [GBP_SCOPE], bearer_methods_supported: ["header"], resource_name: "Google Business Profile (mini-tui)" };
}

function rpc(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, status = 200): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });
}

function textResult(id: unknown, data: unknown, isError = false): Response {
  let text = typeof data === "string" ? data : JSON.stringify(data, null, 1);
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n… (truncated: use pageToken / a narrower readMask or date range)`;
  return rpc(id, { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });
}

const TOKENINFO = "https://oauth2.googleapis.com/tokeninfo";
/** Tokens Google confirmed, by a hash of the token → until when (never the token itself in logs). */
const confirmed = new Map<string, number>();

/**
 * Is this a live Google access token with the Business Profile scope? Checked with Google's
 * tokeninfo (no API quota) and cached until shortly before it expires, so the local tools
 * (saved businesses) cannot be driven with an arbitrary bearer and a dead token answers 401.
 */
export async function tokenAccepted(token: string, fetcher: Fetch = fetch, now = Date.now()): Promise<boolean> {
  const key = createHash("sha256").update(token).digest("hex");
  const until = confirmed.get(key);
  if (until && until > now) return true;
  confirmed.delete(key);
  try {
    const r = await fetcher(`${TOKENINFO}${query({ access_token: token })}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return false;
    const info = (await r.json()) as { scope?: string; expires_in?: string | number };
    if (!String(info.scope ?? "").split(/\s+/).includes(GBP_SCOPE)) return false;
    const left = Number(info.expires_in) * 1000;
    if (confirmed.size > 500) confirmed.clear();
    confirmed.set(key, now + Math.max(0, Math.min(left - 30_000, 10 * 60_000)));
    return left > 0;
  } catch {
    return false;
  }
}

/** Answer one request to the MCP endpoint (Streamable HTTP, stateless, JSON responses). */
export async function handleGbpMcp(request: Request, opts: GbpOptions): Promise<Response> {
  const path = opts.path === undefined ? businessesPath() : opts.path;
  const unauthorized = (why = "a Google OAuth token with the business.manage scope is required") =>
    new Response(JSON.stringify({ error: why }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="${opts.metadataUrl}", scope="${GBP_SCOPE}"` },
    });
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
  const token = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return unauthorized();
  if (!(await tokenAccepted(token, opts.fetcher ?? fetch))) return unauthorized("Google does not accept this token (expired, revoked, or without business.manage): log in again");
  let msg: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  try {
    msg = (await request.json()) as typeof msg;
  } catch {
    return rpcError(null, -32700, "parse error", 400);
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return rpcError(null, -32600, "one JSON-RPC request per POST", 400);
  const id = msg.id;
  const method = String(msg.method ?? "");
  if (id === undefined || method.startsWith("notifications/")) return new Response(null, { status: 202 });
  switch (method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return rpc(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "mini-tui-google-business", version: "1" },
        instructions: "Google Business Profile for the businesses saved in mini-tui. Start with businesses_list; tools marked WRITES change the public profile: confirm with the user first.",
      });
    }
    case "ping":
      return rpc(id, {});
    case "tools/list":
      return rpc(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `unknown tool "${name}"`);
      const args = (msg.params?.arguments && typeof msg.params.arguments === "object" ? msg.params.arguments : {}) as Record<string, unknown>;
      try {
        return textResult(id, await tool.run(args, { token, fetcher: opts.fetcher ?? fetch, path }));
      } catch (error) {
        // The token itself was refused: a 401 makes the agent reload the refreshed one and retry.
        if (error instanceof AuthError) return unauthorized();
        return textResult(id, (error as Error).message, true);
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}
