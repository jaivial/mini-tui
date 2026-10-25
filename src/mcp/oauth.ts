import { createHash, randomBytes } from "node:crypto";

import type { AuthServerMeta, McpOAuthState, OAuthClient, OAuthTokens } from "./store";

/**
 * OAuth for remote MCP servers, as the MCP authorization spec (2025-06-18) lays it out and as
 * Claude Code does it:
 *
 *  1. an unauthenticated request answers 401 with `WWW-Authenticate: Bearer resource_metadata=…`;
 *  2. the protected-resource metadata (RFC 9728) names the authorization server;
 *  3. the authorization-server metadata (RFC 8414, OIDC discovery as fallback) gives the endpoints;
 *  4. the client registers itself (RFC 7591 dynamic registration) for one redirect URI;
 *  5. authorization code + PKCE (S256) + `resource` (RFC 8707), then refresh tokens.
 *
 * Everything here is plain functions over `fetch`; the login flow that waits for the browser
 * lives in `flow.ts`.
 */

const TIMEOUT_MS = 15_000;
export const DEFAULT_CLIENT_NAME = "mini-tui";
const PROTOCOL = "2025-06-18";

export interface Discovery {
  /** False when the server answered without asking for credentials. */
  requiresAuth: boolean;
  resource?: string;
  scope?: string;
  authServer?: AuthServerMeta;
}

function timeout(): AbortSignal {
  return AbortSignal.timeout(TIMEOUT_MS);
}

/** `resource_metadata="…"`, `scope="…"` out of a `WWW-Authenticate: Bearer …` header. */
export function parseWwwAuthenticate(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const m of header.matchAll(/([a-zA-Z_]+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g)) out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? "";
  return out;
}

/** RFC 8414 / 9728 well-known URL: the suffix goes between the origin and the path. */
export function wellKnown(url: string, suffix: string): string {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.origin}/.well-known/${suffix}${path === "" || path === "/" ? "" : path}`;
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json", "MCP-Protocol-Version": PROTOCOL }, signal: timeout() });
    if (!r.ok) return null;
    const body = (await r.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "mini-tui", version: "1" } },
  });
}

function asStrings(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

export function toAuthServerMeta(raw: Record<string, unknown>): AuthServerMeta | null {
  const authorizationEndpoint = typeof raw.authorization_endpoint === "string" ? raw.authorization_endpoint : "";
  const tokenEndpoint = typeof raw.token_endpoint === "string" ? raw.token_endpoint : "";
  if (!authorizationEndpoint || !tokenEndpoint) return null;
  return {
    issuer: typeof raw.issuer === "string" ? raw.issuer : undefined,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: typeof raw.registration_endpoint === "string" ? raw.registration_endpoint : undefined,
    scopes: asStrings(raw.scopes_supported),
    authMethods: asStrings(raw.token_endpoint_auth_methods_supported),
  };
}

async function authServerMetadata(issuer: string): Promise<AuthServerMeta | null> {
  const candidates = [wellKnown(issuer, "oauth-authorization-server"), wellKnown(issuer, "openid-configuration")];
  // OIDC also allows the suffix after the path (`/tenant/.well-known/openid-configuration`).
  const u = new URL(issuer);
  if (u.pathname !== "/" && u.pathname !== "") candidates.push(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
  for (const url of candidates) {
    const raw = await getJson(url);
    const meta = raw && toAuthServerMeta(raw);
    if (meta) return meta;
  }
  return null;
}

/**
 * Ask the server whether it wants OAuth and, if it does, where to get it. Never throws for a
 * server that simply does not do OAuth: that is `requiresAuth: false` (or an error string from
 * the caller's later check).
 */
export async function discover(serverUrl: string, headers: Record<string, string> = {}): Promise<Discovery> {
  let www: Record<string, string> = {};
  let status = 0;
  try {
    const r = await fetch(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL, ...headers },
      body: initializeBody(),
      signal: timeout(),
    });
    status = r.status;
    www = parseWwwAuthenticate(r.headers.get("www-authenticate"));
    await r.body?.cancel().catch(() => undefined);
  } catch (error) {
    throw new Error(`cannot reach ${safeUrl(serverUrl)}: ${(error as Error).message}`);
  }
  const unauthorized = status === 401 || status === 403;
  const prm =
    (www.resource_metadata ? await getJson(www.resource_metadata) : null) ??
    (await getJson(wellKnown(serverUrl, "oauth-protected-resource"))) ??
    (unauthorized ? await getJson(`${new URL(serverUrl).origin}/.well-known/oauth-protected-resource`) : null);
  // Some servers let anyone initialize and list tools and only ask for a token on tools/call
  // (Google's: searchconsole.googleapis.com/mcp answers 200 to initialize, 401 to a call). Their
  // protected-resource metadata is what says so; without it a 200 means "no login needed".
  if (!unauthorized && !asStrings(prm?.authorization_servers)?.length) return { requiresAuth: false };
  const issuers = asStrings(prm?.authorization_servers) ?? [];
  // 2025-03-26 servers have no resource metadata: the MCP server's origin is the authorization server.
  const issuer = issuers[0] ?? new URL(serverUrl).origin;
  let authServer = await authServerMetadata(issuer);
  if (!authServer && !issuers.length) {
    const origin = new URL(serverUrl).origin;
    authServer = { authorizationEndpoint: `${origin}/authorize`, tokenEndpoint: `${origin}/token`, registrationEndpoint: `${origin}/register` };
  }
  if (!authServer) throw new Error(`${safeUrl(serverUrl)} asks for OAuth but its authorization server (${issuer}) publishes no metadata`);
  const scopes = www.scope || (asStrings(prm?.scopes_supported) ?? []).join(" ") || undefined;
  return {
    requiresAuth: true,
    resource: typeof prm?.resource === "string" ? prm.resource : serverUrl,
    scope: scopes,
    authServer,
  };
}

export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

/** Thrown when dynamic registration is refused: the UI explains it and offers the alternatives. */
export class RegistrationRefused extends Error {
  constructor(readonly status: number, readonly clientName: string, detail: string) {
    super(
      `the authorization server refused to register "${clientName}" (HTTP ${status}${detail ? `: ${detail}` : ""}). ` +
        "Some servers only accept approved client names: set another client name, or a client id/secret you registered yourself.",
    );
    this.name = "RegistrationRefused";
  }
}

function authMethodFor(meta: AuthServerMeta, secret: string | undefined, registered?: string): OAuthClient["authMethod"] {
  const supported = meta.authMethods ?? [];
  if (!secret) return "none";
  // Same choice as the MCP SDK: basic when offered, else post; a registration that answered with
  // a method we can do wins only when the server also lists it (Figma answers `none` + a secret).
  if (registered === "client_secret_basic" || registered === "client_secret_post") {
    if (!supported.length || supported.includes(registered)) return registered;
  }
  if (supported.includes("client_secret_basic")) return "client_secret_basic";
  if (supported.includes("client_secret_post")) return "client_secret_post";
  return supported.includes("none") ? "none" : "client_secret_post";
}

export async function registerClient(meta: AuthServerMeta, redirectUri: string, clientName = DEFAULT_CLIENT_NAME, scope?: string): Promise<OAuthClient> {
  if (!meta.registrationEndpoint) throw new Error("the authorization server has no dynamic registration endpoint: a client id is needed");
  const methods = meta.authMethods ?? [];
  const r = await fetch(meta.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: !methods.length || methods.includes("none") ? "none" : "client_secret_post",
      ...(scope ? { scope } : {}),
    }),
    signal: timeout(),
  });
  const text = await r.text();
  if (!r.ok) throw new RegistrationRefused(r.status, clientName, text.trim().slice(0, 160));
  const body = JSON.parse(text) as Record<string, unknown>;
  if (typeof body.client_id !== "string") throw new Error("the registration answer has no client_id");
  const secret = typeof body.client_secret === "string" ? body.client_secret : undefined;
  return {
    clientId: body.client_id,
    ...(secret ? { clientSecret: secret } : {}),
    authMethod: authMethodFor(meta, secret, typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : undefined),
  };
}

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export function randomState(): string {
  return b64url(randomBytes(24));
}

export function authorizationUrl(opts: {
  meta: AuthServerMeta;
  client: OAuthClient;
  redirectUri: string;
  challenge: string;
  state: string;
  scope?: string;
  resource?: string;
}): string {
  const u = new URL(opts.meta.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.client.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("code_challenge", opts.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", opts.state);
  if (opts.scope) u.searchParams.set("scope", opts.scope);
  if (opts.resource) u.searchParams.set("resource", opts.resource);
  // Google issues a refresh token only for offline access, and again only when consent is shown:
  // without these the login works for one hour and then needs the browser again.
  if (isGoogle(opts.meta)) {
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
  }
  return u.toString();
}

export function isGoogle(meta: Pick<AuthServerMeta, "authorizationEndpoint">): boolean {
  try {
    return new URL(meta.authorizationEndpoint).hostname === "accounts.google.com";
  } catch {
    return false;
  }
}

async function tokenRequest(meta: AuthServerMeta, client: OAuthClient, params: Record<string, string>): Promise<OAuthTokens> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (client.authMethod === "client_secret_basic" && client.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString("base64")}`;
  } else {
    body.set("client_id", client.clientId);
    if (client.authMethod === "client_secret_post" && client.clientSecret) body.set("client_secret", client.clientSecret);
  }
  const r = await fetch(meta.tokenEndpoint, { method: "POST", headers, body, signal: timeout() });
  const text = await r.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // some servers answer form-encoded
    data = Object.fromEntries(new URLSearchParams(text));
  }
  if (!r.ok || typeof data.access_token !== "string") {
    const why = typeof data.error_description === "string" ? data.error_description : typeof data.error === "string" ? data.error : `HTTP ${r.status}`;
    throw new Error(`token request failed: ${why}`);
  }
  const expires = Number(data.expires_in);
  return {
    accessToken: data.access_token,
    ...(typeof data.refresh_token === "string" ? { refreshToken: data.refresh_token } : {}),
    ...(typeof data.token_type === "string" ? { tokenType: data.token_type } : {}),
    ...(typeof data.scope === "string" ? { scope: data.scope } : {}),
    ...(Number.isFinite(expires) && expires > 0 ? { expiresAt: Date.now() + expires * 1000 } : {}),
  };
}

export function exchangeCode(opts: { meta: AuthServerMeta; client: OAuthClient; code: string; verifier: string; redirectUri: string; resource?: string }): Promise<OAuthTokens> {
  return tokenRequest(opts.meta, opts.client, {
    grant_type: "authorization_code",
    code: opts.code,
    code_verifier: opts.verifier,
    redirect_uri: opts.redirectUri,
    ...(opts.resource ? { resource: opts.resource } : {}),
  });
}

/** A new access token from the refresh token; the old refresh token is kept when none is rotated in. */
export async function refreshTokens(oauth: McpOAuthState, client: OAuthClient): Promise<OAuthTokens> {
  const old = oauth.tokens;
  if (!old?.refreshToken || !oauth.authServer) throw new Error("no refresh token: log in again");
  const next = await tokenRequest(oauth.authServer, client, {
    grant_type: "refresh_token",
    refresh_token: old.refreshToken,
    ...(oauth.resource ? { resource: oauth.resource } : {}),
  });
  return { ...next, refreshToken: next.refreshToken ?? old.refreshToken };
}

/** Expired, or about to be within `marginMs`. A token with no expiry is taken at its word. */
export function isExpiring(tokens: OAuthTokens | undefined, marginMs = 60_000, now = Date.now()): boolean {
  return !!tokens?.expiresAt && tokens.expiresAt - marginMs <= now;
}

/**
 * `code` and `state` out of whatever the user pasted: the full redirected URL, its query string,
 * or the bare code. Errors the server put in the redirect come back as `error`.
 */
export function parseCallbackInput(text: string): { code?: string; state?: string; error?: string } {
  const raw = text.trim();
  if (!raw) return {};
  let params: URLSearchParams | null = null;
  try {
    params = new URL(raw).searchParams;
  } catch {
    if (raw.includes("=")) params = new URLSearchParams(raw.replace(/^[?#]/, ""));
  }
  if (!params) return /^[\w.~-]+$/.test(raw) ? { code: raw } : {};
  const error = params.get("error");
  if (error) return { error: params.get("error_description") || error };
  return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
}
