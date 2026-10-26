import { authHeaders } from "./client";
import { loadServers, mcpPath, slugId, upsertServer, type McpServerRecord } from "./store";

export * from "./store";
export { probe, probeStored, ensureFresh, startTokenRefresher, ensureTokenRefresher, type ProbeResult } from "./client";
export { startLogin, getLogin, subscribeLogin, cancelLogin, completeFromCallback, completeFromPaste, callbackPage, type LoginView } from "./flow";
export { discover, RegistrationRefused } from "./oauth";
export { handleGbpMcp, protectedResourceMetadata as gbpResourceMetadata, loadBusinesses, businessesPath } from "./googleBusiness";

/** Known remote MCP servers, one click to install. Anything else is "custom URL". */
export interface McpPreset {
  id: string;
  name: string;
  description: string;
  url: string;
  auth: "oauth" | "none" | "header" | "local";
  /** `local` presets: the file the server keeps its bearer token in (read at run time). */
  tokenFile?: string;
  /** The tools the agent gets; the rest stay on the server (prompt size). */
  tools?: string[];
  /** Appended to these tools' descriptions for the agent. */
  hints?: Record<string, string>;
  /** The authorization server has no dynamic registration: a client id/secret must be entered. */
  needsClient?: boolean;
  /** The OAuth scope to ask for, instead of everything the server lists (least privilege). */
  scope?: string;
  /**
   * Leave RFC 8707 `resource` out of the login: the token comes from an authorization server that
   * does not know this server (Google issuing a token for mini-tui's own Business Profile proxy).
   */
  omitResource?: boolean;
  /**
   * `client_name` for dynamic registration. Figma's registration endpoint only accepts the names
   * of the clients it has approved, and answers 403 to any other (measured: "mini-tui",
   * "Cursor", "claude-code" → 403). Claude Code's name is accepted, the same way other
   * third-party clients connect today.
   */
  clientName?: string;
  docs?: string;
}

/**
 * The OpenPencil tools a design task needs: documents, reading the tree, `render` (JSX → layers),
 * the common edits, export to check the result, lint, icons and tokens. 51 of its 132 tools,
 * ~13.5k tokens of schemas instead of ~31k: every task pays for the list in its prompt. `eval`
 * stays out (arbitrary code in the app), and so do the niche ones (booleans, paths, comments,
 * variables CRUD) — editable per server in mcp.json.
 */
export const OPENPENCIL_TOOLS = [
  "list_documents", "new_document", "open_file", "save_file", "activate_document",
  "list_pages", "switch_page", "create_page", "get_page_tree", "get_selection", "get_node", "find_nodes", "query_nodes", "describe", "get_jsx",
  "render", "node_replace_with", "update_node", "batch_update", "set_layout", "set_layout_child", "set_fill", "set_stroke", "set_text", "set_font",
  "set_radius", "set_effects", "delete_node", "clone_node", "node_move", "node_resize", "reparent_node", "arrange", "viewport_zoom_to_fit",
  "export_image", "export_svg", "lint", "lint_fix", "analyze_overlaps", "search_icons", "fetch_icons", "insert_icon", "list_available_fonts",
  "get_components", "create_instance", "list_variables", "design_to_tokens", "get_codegen_prompt", "calc", "undo", "redo",
];

/**
 * OpenPencil's `render` takes ITS design JSX, not Figma's or React's props. Without this a model
 * writes `layoutMode="HORIZONTAL"` or `style={{...}}`, the props are dropped with a warning and
 * the frame collapses to its text (measured: a 400×240 card came out 209×24). Condensed from
 * @open-pencil/design-jsx's authoring reference.
 */
export const OPENPENCIL_RENDER_HINT = [
  "OpenPencil design JSX (not React/HTML/Figma props). Elements: Frame, Text, Span, Paragraph, Icon, Rect, Ellipse, Line, Component, Instance.",
  'Layout: flex="row"|"col" enables auto-layout; gap, p/px/py/pt/pr/pb/pl; justify="start|end|center|between"; items="start|end|center|stretch"; grow; wrap; grid columns="1fr 1fr".',
  'Size: w/h = pixels, "hug" (content) or "fill" (parent space). Fixed-size cards: give w AND h; text in a column: w="fill".',
  'Paint: bg="#hex" (or fill), stroke="#hex" strokeWidth={1}, rounded={16}, shadow="0 4 12 #0003", opacity; gradients: fills={[linearGradient([["#a",0],["#b",1]])]}.',
  'Text: <Text size={16} weight={600} font="Inter" color="#fff" textAlign="center" lineHeight={24}>…</Text>. Icons: <Icon name="lucide:check" size={16} color="#fff" />.',
  'Example: <Frame name="Card" w={400} h={240} flex="col" justify="center" items="center" gap={8} p={24} bg="#0D9488" rounded={16}><Text size={24} weight={700} color="#FFFFFF">Title</Text></Frame>',
  "Check the result with export_image (and lint) before reporting; save with save_file.",
].join("\n");

/** Native calls only: XML-shaped pseudo-calls are text and never reach Linear. */
export const LINEAR_SAVE_ISSUE_HINT = [
  "Invoke this through the API's native tool-call field, never as textual <tool_call>/<function>/<parameter> XML.",
  "To file in a project milestone, pass both project and milestone (its id from list_milestones is unambiguous).",
  "A successful create returns an issue id such as BIZ-123 and a url. Read it back with get_issue or list_issues before reporting it created; a milestone-shaped response is not an issue.",
].join("\n");

export const MCP_PRESETS: McpPreset[] = [
  // Self-hosted on this machine: deploy/openpencil-mcp.service runs the server + the headless
  // desktop app, with a stable token in ~/.openpencil/token (docs/openpencil.md).
  {
    id: "openpencil",
    name: "OpenPencil",
    description: "Self-hosted design editor: render JSX, edit layers, export (this machine)",
    url: "http://127.0.0.1:7600/mcp",
    auth: "local",
    tokenFile: "~/.openpencil/token",
    docs: "https://openpencil.dev/programmable/mcp-server",
    tools: OPENPENCIL_TOOLS,
    hints: { render: OPENPENCIL_RENDER_HINT },
  },
  {
    // Google's own MCP server. Google has no dynamic client registration: the login uses an OAuth
    // client you create in Google Cloud ("Web application", redirects: <web origin>/api/mcp/oauth/callback
    // and http://localhost:33418/callback), entered when installing (docs/google-search-console.md).
    id: "google-search-console",
    name: "Google Search Console",
    description: "Search analytics: clicks, impressions, CTR, position by query/page/country/device (read-only)",
    url: "https://searchconsole.googleapis.com/mcp",
    auth: "oauth",
    needsClient: true,
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    docs: "https://developers.google.com/webmaster-tools",
    // The server also lists `get` ("get San API data"), undocumented and overlapping `query`.
    tools: ["sites_list", "query"],
  },
  {
    // Served by mini-tui's own web server (src/mcp/googleBusiness.ts): Google has no MCP server
    // for Business Profile, so this one proxies its REST APIs with YOUR Google token. The login is
    // the Search Console one (your OAuth client, offline access). Needs the web server running on
    // 4317 (MINITUI_WEB_PORT). Several businesses: saved in ~/.config/mini-tui/google-business.json.
    id: "google-business",
    name: "Google Business Profile",
    description: "Your business profiles: info, hours, reviews and replies, posts, performance; several businesses to choose from",
    url: `http://127.0.0.1:${process.env.MINITUI_WEB_PORT || 4317}/api/gbp/mcp`,
    auth: "oauth",
    needsClient: true,
    omitResource: true,
    scope: "https://www.googleapis.com/auth/business.manage",
    docs: "https://developers.google.com/my-business",
  },
  { id: "figma", name: "Figma", description: "Design context, code and assets from Figma files", url: "https://mcp.figma.com/mcp", auth: "oauth", clientName: "Claude Code", docs: "https://developers.figma.com/docs/figma-mcp-server/" },
  { id: "linear", name: "Linear", description: "Issues, projects and comments", url: "https://mcp.linear.app/mcp", auth: "oauth", hints: { save_issue: LINEAR_SAVE_ISSUE_HINT } },
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
  /** A self-hosted server whose token is read from a file (the file path, never the token). */
  tokenFile?: string;
  state: McpState;
}

export function serverView(s: McpServerRecord, now = Date.now()): McpServerView {
  const tokens = s.oauth?.tokens;
  const oauth = !!s.oauth;
  // With a refresh token the access token's expiry is routine; a refused refresh is not.
  const expired = (!!tokens?.expiresAt && tokens.expiresAt <= now && !tokens.refreshToken) || (!!tokens && !!s.oauth?.refreshError);
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
    ...(s.tokenFile ? { tokenFile: s.tokenFile } : {}),
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
  if (preset?.needsClient && !input.clientId?.trim()) throw new Error(`${preset.name} needs an OAuth client id (and secret) from your Google Cloud project`);
  for (const [label, value] of [["client id", input.clientId], ["client secret", input.clientSecret]] as const) {
    if (value && (value.trim().length > 512 || /\s/.test(value.trim()))) throw new Error(`the ${label} looks wrong (no spaces or line breaks)`);
  }
  const record: McpServerRecord = {
    id: slugId(preset?.id ?? name, existing.map((s) => s.id)),
    name,
    url,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(preset?.tokenFile ? { tokenFile: preset.tokenFile } : {}),
    ...(preset?.tools?.length ? { tools: [...preset.tools] } : {}),
    ...(preset?.hints ? { hints: { ...preset.hints } } : {}),
    ...(preset ? { preset: preset.id } : {}),
    addedAt: Date.now(),
    ...(wantsOAuth
      ? {
          oauth: {
            ...(clientName ? { clientName } : {}),
            ...(preset?.scope ? { scope: preset.scope } : {}),
            ...(preset?.omitResource ? { omitResource: true } : {}),
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
  return {
    // Where the agent re-reads a server's credentials when they are refused mid-run: the
    // access tokens below last an hour (Google's), runs and their children much longer.
    ...(path ? { MINI_AGENT_MCP_FILE: path } : {}),
    MINI_AGENT_MCP_SERVERS: JSON.stringify(servers.map((s) => {
    // Preset guidance is applied at spawn as well as install: existing mcp.json files receive
    // fixes without forcing users to remove and re-authenticate the server. Local edits win.
    const preset = s.preset ? MCP_PRESETS.find((p) => p.id === s.preset) : undefined;
    const hints = { ...preset?.hints, ...s.hints };
    return { name: s.id, url: s.url, headers: authHeaders(s), ...(s.tools?.length ? { tools: s.tools } : {}), ...(Object.keys(hints).length ? { hints } : {}) };
    })),
  };
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
