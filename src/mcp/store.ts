import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Installed MCP servers, one JSON file (0600) shared by the terminal UI, the web server and the
 * agent runs they spawn: `~/.config/mini-tui/mcp.json`.
 *
 * Tokens live here because the agent needs them; nothing that reads this file for a UI hands
 * them back out (see `serverView`).
 */

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  /** How the token endpoint wants the client to authenticate (`none` = public client + PKCE). */
  authMethod: "none" | "client_secret_post" | "client_secret_basic";
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  /** Epoch ms; absent when the server did not say. */
  expiresAt?: number;
}

export interface AuthServerMeta {
  issuer?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopes?: string[];
  /** `token_endpoint_auth_methods_supported`. */
  authMethods?: string[];
}

export interface McpOAuthState {
  /** `client_name` sent in dynamic registration (some servers only accept known names). */
  clientName?: string;
  /** A client registered out of band: used for every redirect instead of dynamic registration. */
  staticClient?: OAuthClient;
  /** Dynamically registered clients, one per redirect URI (a loopback port, a web origin). */
  clients?: Record<string, OAuthClient>;
  tokens?: OAuthTokens;
  /** Key in `clients` of the client the tokens were issued to (refresh must use the same one). */
  tokenClient?: string;
  authServer?: AuthServerMeta;
  resource?: string;
  scope?: string;
}

export interface McpServerRecord {
  id: string;
  name: string;
  url: string;
  /** Static headers (an API key server); values are secrets. */
  headers?: Record<string, string>;
  preset?: string;
  addedAt: number;
  /** Disabled servers stay installed but are not handed to the agent. */
  disabled?: boolean;
  oauth?: McpOAuthState;
}

/** Null under test with no explicit path: a test run never touches the developer's home. */
export function mcpPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.MINITUI_MCP_PATH) return env.MINITUI_MCP_PATH;
  if (env.NODE_ENV === "test" || env.MINITUI_TEST === "1") return null;
  return join(homedir(), ".config", "mini-tui", "mcp.json");
}

export function loadServers(path: string | null = mcpPath()): McpServerRecord[] {
  if (!path) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { servers?: unknown };
    return Array.isArray(data?.servers) ? (data.servers as McpServerRecord[]).filter((s) => s && typeof s.id === "string" && typeof s.url === "string") : [];
  } catch {
    return [];
  }
}

export function saveServers(servers: McpServerRecord[], path: string | null = mcpPath()): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename: the TUI and the web server can both write, and a reader must never see half a file.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ servers }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort permissions
  }
}

export function getServer(id: string, path: string | null = mcpPath()): McpServerRecord | undefined {
  return loadServers(path).find((s) => s.id === id);
}

/** Read-modify-write of one server, so concurrent edits of two different servers both survive. */
export function updateServer(id: string, change: (s: McpServerRecord) => McpServerRecord, path: string | null = mcpPath()): McpServerRecord | undefined {
  const all = loadServers(path);
  const at = all.findIndex((s) => s.id === id);
  if (at < 0) return undefined;
  all[at] = change(all[at]!);
  saveServers(all, path);
  return all[at];
}

export function upsertServer(server: McpServerRecord, path: string | null = mcpPath()): void {
  saveServers([...loadServers(path).filter((s) => s.id !== server.id), server], path);
}

export function removeServer(id: string, path: string | null = mcpPath()): boolean {
  const all = loadServers(path);
  const next = all.filter((s) => s.id !== id);
  if (next.length === all.length) return false;
  saveServers(next, path);
  return true;
}

export function slugId(name: string, taken: string[] = []): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "mcp";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}
