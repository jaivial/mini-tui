import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import { TokenError, refreshTokens, isExpiring, safeUrl } from "./oauth";
import { getServer, loadServers, updateServer, mcpPath, type McpServerRecord, type OAuthClient } from "./store";

/**
 * Just enough of an MCP Streamable HTTP client to answer "does this server work with what we
 * hold": initialize, then tools/list. The agent (agent-rs/src/mcp.rs) is the real client.
 */

const PROTOCOL = "2025-06-18";

/**
 * Presets whose server lists its tools without a token, so a listing is not a working login.
 * The value is a read-only, argument-free tool to call instead: the call is what proves the token.
 */
const PRESETS_LIST_ANONYMOUSLY: Record<string, string> = { "google-search-console": "sites_list" };

export interface ProbeResult {
  ok: boolean;
  /** 401/403: the server wants (new) credentials. */
  needsAuth?: boolean;
  tools?: { name: string; description?: string }[];
  serverName?: string;
  error?: string;
}

function parseBody(contentType: string, body: string): Record<string, unknown> | null {
  if (!body.trim()) return null;
  if (!contentType.includes("text/event-stream")) return JSON.parse(body) as Record<string, unknown>;
  for (const block of body.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data) continue;
    try {
      const value = JSON.parse(data) as Record<string, unknown>;
      if ("result" in value || "error" in value) return value;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** The client to refresh with: the one registered for the redirect the tokens came through. */
export function clientFor(server: McpServerRecord): OAuthClient | undefined {
  const oauth = server.oauth;
  if (!oauth) return undefined;
  if (oauth.staticClient) return oauth.staticClient;
  return (oauth.tokenClient && oauth.clients?.[oauth.tokenClient]) || Object.values(oauth.clients ?? {})[0];
}

/** Headers the agent and the probe send: static ones plus a bearer token, if there is one. */
export function authHeaders(server: McpServerRecord): Record<string, string> {
  const headers = { ...(server.headers ?? {}) };
  const token = server.oauth?.tokens?.accessToken ?? readTokenFile(server.tokenFile);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** The token a self-hosted server keeps in a file (`~` = home); undefined when it is not there. */
export function readTokenFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    const token = readFileSync(path.replace(/^~(?=\/|$)/, homedir()), "utf8").trim();
    return token && !/[\r\n]/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Refresh the access token when it is about to expire. Returns the (possibly updated) record;
 * a failed refresh leaves the old tokens in place and reports why.
 */
export async function ensureFresh(server: McpServerRecord, path: string | null = mcpPath(), marginMs = 120_000): Promise<{ server: McpServerRecord; error?: string }> {
  const oauth = server.oauth;
  if (!oauth?.tokens || !isExpiring(oauth.tokens, marginMs)) return { server };
  const client = clientFor(server);
  if (!client || !oauth.tokens.refreshToken) return { server, error: "the access token expired: log in again" };
  try {
    const tokens = await refreshTokens(oauth, client);
    const fresh = (o: typeof oauth | undefined) => {
      const { refreshError: _dead, ...rest } = o ?? {};
      return { ...rest, tokens };
    };
    const next = updateServer(server.id, (s) => ({ ...s, oauth: fresh(s.oauth) }), path) ?? { ...server, oauth: fresh(oauth) };
    return { server: next };
  } catch (error) {
    const message = (error as Error).message;
    // A dead grant stays dead: record it so the UI shows "expired" and the timer stops asking.
    // Network errors and 5xx are not recorded; the next tick tries again.
    if (error instanceof TokenError && error.code === "invalid_grant") {
      const next = updateServer(server.id, (s) => ({ ...s, oauth: { ...s.oauth, refreshError: message } }), path) ?? server;
      return { server: next, error: `${message}: log in again` };
    }
    return { server, error: message };
  }
}

/** Refresh every token close to expiring. Run on a timer by the TUI and the web server. */
export async function refreshDue(path: string | null = mcpPath(), marginMs = 15 * 60_000): Promise<void> {
  for (const s of loadServers(path)) {
    if (s.disabled || !s.oauth?.tokens?.refreshToken || s.oauth.refreshError) continue;
    await ensureFresh(s, path, marginMs).catch(() => undefined);
  }
}

let sharedRefresher: (() => void) | undefined;

/**
 * One refresher per process, started by whatever spawns agent runs (the CLI and the channel
 * consumers too, not only the TUI and the web server): runs outlive the one-hour tokens they get
 * and reload them from mcp.json on a 401 (agent-rs/src/mcp.rs), so the file must stay fresh.
 */
export function ensureTokenRefresher(): void {
  sharedRefresher ??= startTokenRefresher();
}

export function startTokenRefresher(everyMs = 5 * 60_000): () => void {
  if (!mcpPath()) return () => {};
  void refreshDue();
  const timer = setInterval(() => void refreshDue(), everyMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

const AUTH_FAILURE = /\b(UNAUTHENTICATED|PERMISSION_DENIED|invalid[_ ]?(oauth|token|credentials?)|authentication credential|unauthori[sz]ed|401)\b/i;

function toolError(body: Record<string, unknown> | null): string {
  const err = body?.error as { message?: string } | undefined;
  if (err?.message) return err.message.slice(0, 200);
  const parts = (body?.result as { content?: { text?: string }[] } | undefined)?.content ?? [];
  return parts.map((p) => p.text ?? "").join(" ").trim().slice(0, 200) || "the call failed";
}

export async function probe(server: McpServerRecord, timeoutMs = 15_000): Promise<ProbeResult> {
  const url = server.url;
  // An OAuth server with no login yet. Some answer initialize and tools/list anonymously and
  // refuse only the calls (Google's MCP servers): listing tools there proves nothing.
  const verifyWith = server.preset ? PRESETS_LIST_ANONYMOUSLY[server.preset] : undefined;
  if (server.oauth && !server.oauth.tokens && verifyWith) {
    return { ok: false, needsAuth: true, error: "this server needs a login" };
  }
  const base = { "content-type": "application/json", accept: "application/json, text/event-stream", ...authHeaders(server) };
  let session: string | null = null;
  let protocol = PROTOCOL;
  const post = async (payload: Record<string, unknown>) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { ...base, "MCP-Protocol-Version": protocol, ...(session ? { "Mcp-Session-Id": session } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r;
  };
  try {
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "mini-tui", version: "1" } } });
    if (init.status === 401 || init.status === 403) {
      await init.body?.cancel().catch(() => undefined);
      // A self-hosted token is not an OAuth login: the fix is the token file, not a browser.
      if (server.tokenFile) return { ok: false, error: `the server refused the token in ${server.tokenFile} (missing, or the server was started with another one)` };
      return { ok: false, needsAuth: true, error: server.oauth?.tokens ? "the server refused the token: log in again" : "this server needs a login" };
    }
    if (!init.ok) return { ok: false, error: `HTTP ${init.status} from ${safeUrl(url)}` };
    session = init.headers.get("mcp-session-id");
    const initBody = parseBody(init.headers.get("content-type") ?? "", await init.text());
    const result = initBody?.result as { protocolVersion?: string; serverInfo?: { name?: string } } | undefined;
    if (!result) return { ok: false, error: `${safeUrl(url)} did not answer initialize` };
    if (result.protocolVersion) protocol = result.protocolVersion;
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }).then((r) => r.body?.cancel()).catch(() => undefined);
    const tools: { name: string; description?: string }[] = [];
    let cursor: unknown = undefined;
    for (let page = 0; page < 20; page++) {
      const r = await post({ jsonrpc: "2.0", id: 2 + page, method: "tools/list", params: cursor ? { cursor } : {} });
      if (!r.ok) return { ok: false, error: `tools/list: HTTP ${r.status}` };
      const body = parseBody(r.headers.get("content-type") ?? "", await r.text());
      const listed = (body?.result as { tools?: { name: string; description?: string }[]; nextCursor?: unknown } | undefined) ?? {};
      for (const t of listed.tools ?? []) if (t && typeof t.name === "string") tools.push({ name: t.name, description: t.description?.slice(0, 200) });
      cursor = listed.nextCursor;
      if (!cursor) break;
    }
    if (verifyWith) {
      const r = await post({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: verifyWith, arguments: {} } });
      const refused = r.status === 401 || r.status === 403;
      const text = refused ? "" : await r.text();
      const body = refused ? null : parseBody(r.headers.get("content-type") ?? "", text);
      const failed = !body || "error" in body || (body.result as { isError?: boolean } | undefined)?.isError;
      // Only an authentication failure means "log in again". A quota error, a 5xx or a
      // tool error must not send the user back to the browser with a perfectly good login.
      if (failed && (refused || AUTH_FAILURE.test(text))) return { ok: false, needsAuth: true, error: "the server refused the token: log in again" };
      if (failed) return { ok: false, error: `${verifyWith}: ${r.ok ? toolError(body) : `HTTP ${r.status}`}` };
    }
    // The probe is done with its session: end it (servers cap them; OpenPencil allows 10).
    if (session) {
      await fetch(url, { method: "DELETE", headers: { ...authHeaders(server), "Mcp-Session-Id": session }, signal: AbortSignal.timeout(2000) })
        .then((r) => r.body?.cancel())
        .catch(() => undefined);
    }
    return { ok: true, tools, serverName: result.serverInfo?.name };
  } catch (error) {
    const hint =
      server.preset === "openpencil"
        ? " — start it with `systemctl --user start openpencil-mcp` (docs/openpencil.md)"
        : server.preset === "google-business"
          ? " — it is served by the mini-tui web server (port 4317): start it (docs/google-business-profile.md)"
          : "";
    return { ok: false, error: `cannot reach ${safeUrl(url)}: ${(error as Error).message}${hint}` };
  }
}

/** Probe a stored server with a fresh token. */
export async function probeStored(id: string, path: string | null = mcpPath()): Promise<ProbeResult> {
  const stored = getServer(id, path);
  if (!stored) return { ok: false, error: "no such server" };
  const { server, error } = await ensureFresh(stored, path);
  const result = await probe(server);
  if (!result.ok && error && result.needsAuth) result.error = error;
  return result;
}
