import { createHash } from "node:crypto";

import { probe } from "./client";
import {
  DEFAULT_CLIENT_NAME,
  RegistrationRefused,
  authorizationUrl,
  discover,
  exchangeCode,
  parseCallbackInput,
  pkce,
  randomState,
  registerClient,
} from "./oauth";
import { getServer, mcpPath, updateServer, type McpServerRecord, type OAuthClient } from "./store";

/**
 * One OAuth login in flight: the URL the user opens, and whatever completes it — the browser
 * landing on our redirect (a loopback listener for the terminal, the web server's callback route
 * for the web app) or the user pasting the redirected URL by hand (a browser on another machine).
 *
 * Completion is detected here, not by the UI: the UI subscribes and is told `done` or `error`.
 */

export type LoginStatus = "pending" | "exchanging" | "done" | "error";

export interface LoginView {
  id: string;
  serverId: string;
  serverName: string;
  url: string;
  redirectUri: string;
  status: LoginStatus;
  error?: string;
  toolCount?: number;
  startedAt: number;
  expiresAt: number;
}

interface Pending {
  view: LoginView;
  verifier: string;
  clientKey: string;
  client: OAuthClient;
  path: string | null;
  stop?: () => void;
  listeners: Set<(view: LoginView) => void>;
  timer?: ReturnType<typeof setTimeout>;
}

const LOGIN_TTL_MS = 10 * 60_000;
const flows = new Map<string, Pending>();

/** A redirect URI is a client-registration key; hashing keeps paths out of the JSON keys. */
function clientKeyOf(redirectUri: string): string {
  return createHash("sha256").update(redirectUri).digest("hex").slice(0, 16);
}

function publish(p: Pending) {
  const view = { ...p.view };
  for (const fn of p.listeners) {
    try {
      fn(view);
    } catch {
      // a listener that throws must not stop the others
    }
  }
}

function finish(p: Pending, status: "done" | "error", extra: Partial<LoginView> = {}) {
  if (p.view.status === "done" || p.view.status === "error") return;
  Object.assign(p.view, { status, ...extra });
  if (p.timer) clearTimeout(p.timer);
  p.stop?.();
  p.stop = undefined;
  publish(p);
  // Kept a little while so a late poll still reads the outcome.
  setTimeout(() => flows.delete(p.view.id), 60_000).unref?.();
}

export function getLogin(id: string): LoginView | undefined {
  const p = flows.get(id);
  return p ? { ...p.view } : undefined;
}

export function subscribeLogin(id: string, fn: (view: LoginView) => void): () => void {
  const p = flows.get(id);
  if (!p) return () => {};
  p.listeners.add(fn);
  return () => p.listeners.delete(fn);
}

export function cancelLogin(id: string): void {
  const p = flows.get(id);
  if (p) finish(p, "error", { error: "cancelled" });
}

/** The client for this redirect: an out-of-band one, a cached registration, or a new registration. */
async function clientFor(server: McpServerRecord, redirectUri: string, path: string | null): Promise<{ client: OAuthClient; key: string; server: McpServerRecord }> {
  const oauth = server.oauth ?? {};
  if (oauth.staticClient) return { client: oauth.staticClient, key: "static", server };
  const key = clientKeyOf(redirectUri);
  const cached = oauth.clients?.[key];
  if (cached) return { client: cached, key, server };
  const client = await registerClient(oauth.authServer!, redirectUri, oauth.clientName || DEFAULT_CLIENT_NAME, oauth.scope);
  const next = updateServer(server.id, (s) => ({ ...s, oauth: { ...s.oauth, clients: { ...(s.oauth?.clients ?? {}), [key]: client } } }), path) ?? server;
  return { client, key, server: next };
}

export interface StartOptions {
  serverId: string;
  /** Where the browser comes back to. Required unless `loopback` is set. */
  redirectUri?: string;
  /** Start a 127.0.0.1 listener and use it as the redirect (the terminal). */
  loopback?: boolean | { port?: number };
  path?: string | null;
}

/**
 * Start (or restart) a login. Re-discovers the authorization server every time: endpoints move,
 * and a stale metadata copy is the classic "login page 404s" bug.
 */
export async function startLogin(opts: StartOptions): Promise<LoginView> {
  const path = opts.path === undefined ? mcpPath() : opts.path;
  let server = getServer(opts.serverId, path);
  if (!server) throw new Error(`no MCP server "${opts.serverId}"`);

  const found = await discover(server.url, server.headers ?? {});
  if (!found.requiresAuth || !found.authServer) throw new Error(`${server.name} does not ask for OAuth: it works without a login`);
  server =
    updateServer(server.id, (s) => ({ ...s, oauth: { ...s.oauth, authServer: found.authServer, resource: found.resource, scope: s.oauth?.scope ?? found.scope } }), path) ?? server;

  const state = randomState();
  const { verifier, challenge } = pkce();
  let stop: (() => void) | undefined;
  let redirectUri = opts.redirectUri ?? "";
  let pendingRef: Pending | undefined;

  if (opts.loopback) {
    // A client registered by hand (Google) knows ONE redirect URI: a random fallback port would
    // only end in the provider's "redirect_uri_mismatch" page.
    const fixedPort = !!server.oauth?.staticClient;
    const listener = listenLoopback(typeof opts.loopback === "object" ? opts.loopback.port : undefined, fixedPort, (params) => {
      const p = pendingRef;
      if (!p) return { ok: false, message: "This login is no longer pending." };
      if (params.get("state") !== state) return { ok: false, message: "This page belongs to another login attempt." };
      void complete(p, params.get("code") ?? undefined, params.get("error_description") || params.get("error") || undefined);
      return { ok: true, message: `${server!.name} is connected. You can close this tab and go back to the terminal.` };
    });
    redirectUri = listener.redirectUri;
    stop = listener.stop;
  }
  if (!redirectUri) throw new Error("a redirect URI is needed");

  let registered: Awaited<ReturnType<typeof clientFor>>;
  try {
    registered = await clientFor(server, redirectUri, path);
  } catch (error) {
    stop?.();
    throw error;
  }

  const url = authorizationUrl({
    meta: registered.server.oauth!.authServer!,
    client: registered.client,
    redirectUri,
    challenge,
    state,
    scope: registered.server.oauth?.scope,
    resource: registered.server.oauth?.resource,
  });
  const now = Date.now();
  const p: Pending = {
    view: { id: state, serverId: server.id, serverName: server.name, url, redirectUri, status: "pending", startedAt: now, expiresAt: now + LOGIN_TTL_MS },
    verifier,
    clientKey: registered.key,
    client: registered.client,
    path,
    stop,
    listeners: new Set(),
  };
  pendingRef = p;
  // One login per server: a new attempt supersedes the old one.
  for (const other of flows.values()) if (other.view.serverId === server.id && other.view.status === "pending") finish(other, "error", { error: "superseded by a new login" });
  flows.set(state, p);
  p.timer = setTimeout(() => finish(p, "error", { error: "the login timed out: start it again" }), LOGIN_TTL_MS);
  (p.timer as { unref?: () => void }).unref?.();
  return { ...p.view };
}

async function complete(p: Pending, code: string | undefined, error: string | undefined): Promise<void> {
  if (p.view.status !== "pending") return;
  if (error || !code) return finish(p, "error", { error: error ? `the provider said: ${error}` : "the redirect carried no code" });
  p.view.status = "exchanging";
  publish(p);
  try {
    const server = getServer(p.view.serverId, p.path);
    if (!server?.oauth?.authServer) throw new Error("the server was removed during the login");
    const tokens = await exchangeCode({ meta: server.oauth.authServer, client: p.client, code, verifier: p.verifier, redirectUri: p.view.redirectUri, resource: server.oauth.resource });
    const saved = updateServer(server.id, (s) => ({ ...s, disabled: false, oauth: { ...s.oauth, tokens, tokenClient: p.clientKey } }), p.path);
    // Prove it: the login is only "done" when the MCP server takes the token.
    const check = saved ? await probe(saved) : { ok: false, error: "not saved" };
    if (!check.ok) return finish(p, "error", { error: `logged in, but the server still refuses: ${check.error ?? "unknown error"}` });
    finish(p, "done", { toolCount: check.tools?.length ?? 0 });
  } catch (err) {
    finish(p, "error", { error: (err as Error).message });
  }
}

/** The web server's callback route (and anything else holding the query string). */
export async function completeFromCallback(params: URLSearchParams): Promise<LoginView | undefined> {
  const p = flows.get(params.get("state") ?? "");
  if (!p) return undefined;
  await complete(p, params.get("code") ?? undefined, params.get("error_description") || params.get("error") || undefined);
  return { ...p.view };
}

/**
 * The user pasted the address the browser ended on (or just the code). Used when the browser is
 * on another machine and the loopback redirect could not reach us.
 */
export async function completeFromPaste(id: string, text: string): Promise<LoginView> {
  const p = flows.get(id);
  if (!p) throw new Error("no such login");
  const parsed = parseCallbackInput(text);
  if (parsed.state && parsed.state !== id) throw new Error("that address belongs to another login attempt");
  if (!parsed.code && !parsed.error) throw new Error("no code found in what was pasted");
  await complete(p, parsed.code, parsed.error);
  return { ...p.view };
}

// ------------------------------------------------------------------ loopback listener

const CALLBACK_PATH = "/callback";
/** A fixed port first, so the registered client (keyed by redirect URI) is reused across logins. */
export const LOOPBACK_PORT = Number(process.env.MINITUI_MCP_CALLBACK_PORT ?? 33418);

export function callbackPage(ok: boolean, message: string): string {
  const esc = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const tone = ok ? "#157c4e" : "#c22e57";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>mini · ${ok ? "connected" : "login failed"}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;background:#fbfbfd;color:#1a1a21}
@media (prefers-color-scheme:dark){body{background:#121319;color:#f3f4f8}}
main{max-width:26rem;padding:2rem;text-align:center;animation:in .4s cubic-bezier(.16,1,.3,1) both}
.dot{width:3rem;height:3rem;border-radius:50%;margin:0 auto 1rem;display:grid;place-items:center;background:${tone}22;color:${tone};font-size:1.4rem}
@keyframes in{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}</style></head>
<body><main><div class="dot">${ok ? "✓" : "!"}</div><h1 style="font-size:18px;margin:0 0 .4rem">${ok ? "Connected" : "Login failed"}</h1><p style="margin:0;opacity:.75">${esc}</p></main>
<script>${ok ? "setTimeout(()=>{try{window.close()}catch{}},1800)" : ""}</script></body></html>`;
}

function listenLoopback(port: number | undefined, fixedPort: boolean, onCallback: (params: URLSearchParams) => { ok: boolean; message: string }): { redirectUri: string; stop: () => void } {
  const serve = (p: number, hostname = "127.0.0.1") =>
    Bun.serve({
      hostname,
      port: p,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== CALLBACK_PATH) return new Response("not found", { status: 404 });
        const { ok, message } = onCallback(url.searchParams);
        return new Response(callbackPage(ok, message), { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      },
    });
  let server: ReturnType<typeof serve>;
  try {
    server = serve(port ?? LOOPBACK_PORT);
  } catch (error) {
    if (fixedPort) throw new Error(`port ${port ?? LOOPBACK_PORT} is busy (another login in progress?): this OAuth client only accepts http://localhost:${port ?? LOOPBACK_PORT}/callback`, { cause: error });
    server = serve(0); // the fixed port is taken (another login, another app): any free one
  }
  // `localhost` resolves to ::1 first on some systems: listen there too, on the same port.
  let v6: ReturnType<typeof serve> | undefined;
  try {
    v6 = serve(server.port as number, "::1");
  } catch {
    // no IPv6 loopback (or the port is taken there): the browser falls back to 127.0.0.1
  }
  // `localhost`, not 127.0.0.1: some authorization servers only accept that spelling for loopback.
  return {
    redirectUri: `http://localhost:${server.port}${CALLBACK_PATH}`,
    stop: () => {
      server.stop(true);
      v6?.stop(true);
    },
  };
}

export { RegistrationRefused };
