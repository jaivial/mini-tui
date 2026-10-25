import { authHeaders } from "./client";
import { loadServers, mcpPath, slugId, upsertServer, type McpServerRecord } from "./store";

export * from "./store";
export { probe, probeStored, ensureFresh, startTokenRefresher, type ProbeResult } from "./client";
export { startLogin, getLogin, subscribeLogin, cancelLogin, completeFromCallback, completeFromPaste, callbackPage, type LoginView } from "./flow";
export { discover, RegistrationRefused } from "./oauth";

/** Known remote MCP servers, one click to install. Anything else is "custom URL". */
export interface McpPreset {
  id: string;
  name: string;
  description: string;
  url: string;
  auth: "oauth" | "none" | "header";
  /**
   * `client_name` for dynamic registration. Figma's registration endpoint only accepts the names
   * of the clients it has approved, and answers 403 to any other (measured: "mini-tui",
   * "Cursor", "claude-code" → 403). Claude Code's name is accepted, the same way other
   * third-party clients connect today.
   */
  clientName?: string;
  docs?: string;
}

export const MCP_PRESETS: McpPreset[] = [
  { id: "figma", name: "Figma", description: "Design context, code and assets from Figma files", url: "https://mcp.figma.com/mcp", auth: "oauth", clientName: "Claude Code", docs: "https://developers.figma.com/docs/figma-mcp-server/" },
  { id: "linear", name: "Linear", description: "Issues, projects and comments", url: "https://mcp.linear.app/mcp", auth: "oauth" },
  { id: "notion", name: "Notion", description: "Search and edit pages and databases", url: "https://mcp.notion.com/mcp", auth: "oauth" },
  { id: "atlassian", name: "Atlassian", description: "Jira and Confluence", url: "https://mcp.atlassian.com/v1/mcp", auth: "oauth" },
  { id: "stripe", name: "Stripe", description: "Payments, customers and docs", url: "https://mcp.stripe.com", auth: "oauth" },
  { id: "vercel", name: "Vercel", description: "Projects, deployments and logs", url: "https://mcp.vercel.com", auth: "oauth" },
];

export type McpState = "connected" | "needs-login" | "expired" | "disabled" | "ready";

/** What a UI may see: no token, no secret, no header value. */
export interface McpServerView {
  id: string;
  name: string;
  url: string;
  preset?: string;
  addedAt: number;
  disabled: boolean;
  oauth: boolean;
  loggedIn: boolean;
  expiresAt?: number;
  headerNames: string[];
  state: McpState;
}

export function serverView(s: McpServerRecord, now = Date.now()): McpServerView {
  const tokens = s.oauth?.tokens;
  const oauth = !!s.oauth;
  const expired = !!tokens?.expiresAt && tokens.expiresAt <= now && !tokens.refreshToken;
  const state: McpState = s.disabled ? "disabled" : !oauth ? "ready" : !tokens ? "needs-login" : expired ? "expired" : "connected";
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    preset: s.preset,
    addedAt: s.addedAt,
    disabled: !!s.disabled,
    oauth,
    loggedIn: !!tokens,
    ...(tokens?.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
    headerNames: Object.keys(s.headers ?? {}),
    state,
  };
}

export function listViews(path: string | null = mcpPath()): McpServerView[] {
  return loadServers(path).map((s) => serverView(s));
}

export interface AddInput {
  name?: string;
  url?: string;
  preset?: string;
  headers?: Record<string, string>;
  /** Override the dynamic-registration client name. */
  clientName?: string;
  clientId?: string;
  clientSecret?: string;
}

/** Validate and store a server. OAuth is not decided here: the first login (or probe) finds out. */
export function addServer(input: AddInput, path: string | null = mcpPath()): McpServerRecord {
  const preset = input.preset ? MCP_PRESETS.find((p) => p.id === input.preset) : undefined;
  if (input.preset && !preset) throw new Error(`unknown preset "${input.preset}"`);
  const url = (input.url ?? preset?.url ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("a valid http(s) URL is needed");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new Error("MCP servers must use https (http only on localhost)");
  const name = (input.name ?? preset?.name ?? parsed.hostname).trim().slice(0, 60) || parsed.hostname;
  const existing = loadServers(path);
  const headers = Object.fromEntries(
    Object.entries(input.headers ?? {})
      .map(([k, v]) => [k.trim(), String(v).trim()] as const)
      .filter(([k, v]) => /^[A-Za-z0-9-]+$/.test(k) && v && !/[\r\n]/.test(v)),
  );
  const clientName = input.clientName?.trim() || preset?.clientName;
  const wantsOAuth = preset?.auth === "oauth" || !!clientName || !!input.clientId;
  const record: McpServerRecord = {
    id: slugId(preset?.id ?? name, existing.map((s) => s.id)),
    name,
    url,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(preset ? { preset: preset.id } : {}),
    addedAt: Date.now(),
    ...(wantsOAuth
      ? {
          oauth: {
            ...(clientName ? { clientName } : {}),
            ...(input.clientId?.trim()
              ? { staticClient: { clientId: input.clientId.trim(), ...(input.clientSecret?.trim() ? { clientSecret: input.clientSecret.trim() } : {}), authMethod: input.clientSecret?.trim() ? ("client_secret_post" as const) : ("none" as const) } }
              : {}),
          },
        }
      : {}),
  };
  upsertServer(record, path);
  return record;
}

/** Mark a stored server as OAuth (a custom URL whose probe answered 401). */
export function markOAuth(id: string, path: string | null = mcpPath()): void {
  const all = loadServers(path);
  const s = all.find((x) => x.id === id);
  if (s && !s.oauth) upsertServer({ ...s, oauth: {} }, path);
}

/**
 * The environment a run gets: every enabled server that can authenticate, with its headers.
 * Read on every spawn, so a login finished a second ago is in the next task.
 */
export function mcpRunEnv(path: string | null = mcpPath()): Record<string, string> {
  const servers = loadServers(path).filter((s) => !s.disabled && (!s.oauth || s.oauth.tokens));
  if (!servers.length) return {};
  return { MINI_AGENT_MCP_SERVERS: JSON.stringify(servers.map((s) => ({ name: s.id, url: s.url, headers: authHeaders(s) }))) };
}

/** Forget the tokens (the registered clients are kept, so the next login skips registration). */
export function logoutServer(id: string, path: string | null = mcpPath()): boolean {
  const all = loadServers(path);
  const s = all.find((x) => x.id === id);
  if (!s?.oauth) return false;
  const { tokens: _tokens, tokenClient: _client, ...rest } = s.oauth;
  upsertServer({ ...s, oauth: rest }, path);
  return true;
}

export function setDisabled(id: string, disabled: boolean, path: string | null = mcpPath()): McpServerRecord | undefined {
  const s = loadServers(path).find((x) => x.id === id);
  if (!s) return undefined;
  const next = { ...s, disabled };
  upsertServer(next, path);
  return next;
}
