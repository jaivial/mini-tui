import { refreshTokens, isExpiring, safeUrl } from "./oauth";
import { getServer, updateServer, mcpPath, type McpServerRecord, type OAuthClient } from "./store";

/**
 * Just enough of an MCP Streamable HTTP client to answer "does this server work with what we
 * hold": initialize, then tools/list. The agent (agent-rs/src/mcp.rs) is the real client.
 */

const PROTOCOL = "2025-06-18";

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
  const token = server.oauth?.tokens?.accessToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
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
    const next = updateServer(server.id, (s) => ({ ...s, oauth: { ...s.oauth, tokens } }), path) ?? { ...server, oauth: { ...oauth, tokens } };
    return { server: next };
  } catch (error) {
    return { server, error: (error as Error).message };
  }
}

/** Refresh every token close to expiring. Run on a timer by the TUI and the web server. */
export async function refreshDue(path: string | null = mcpPath(), marginMs = 15 * 60_000): Promise<void> {
  const { loadServers } = await import("./store");
  for (const s of loadServers(path)) {
    if (s.disabled || !s.oauth?.tokens?.refreshToken) continue;
    await ensureFresh(s, path, marginMs).catch(() => undefined);
  }
}

export function startTokenRefresher(everyMs = 5 * 60_000): () => void {
  if (!mcpPath()) return () => {};
  void refreshDue();
  const timer = setInterval(() => void refreshDue(), everyMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

export async function probe(server: McpServerRecord, timeoutMs = 15_000): Promise<ProbeResult> {
  const url = server.url;
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
    return { ok: true, tools, serverName: result.serverInfo?.name };
  } catch (error) {
    return { ok: false, error: `cannot reach ${safeUrl(url)}: ${(error as Error).message}` };
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
