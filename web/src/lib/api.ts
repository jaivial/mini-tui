/** Thin fetch wrapper around the mini-tui web server. */
import type { AttachmentRef } from "./attachments";
import { ageClock } from "./clock";
import type {
  CommandInfo,
  ConnectResult,
  CreateSessionBody,
  HistoryItem,
  FolderListing,
  FolderSummary,
  ModelInfo,
  ProviderCatalogEntry,
  ProviderView,
  RemoteHost,
  RouteLevel,
  RouterPreview,
  RouterStatusView,
  SessionMeta,
  SettingsView,
  SkillInfo,
  WireSession,
  AgentsView,
  AgentsBrief,
  AgentDef,
  QueueView,
  CuTab,
  McpServerView,
  McpPreset,
  McpLogin,
} from "./types";

export interface McpProbe {
  ok: boolean;
  needsAuth: boolean;
  tools: number | unknown[];
  error?: string;
}

/**
 * A failed call, with the status it failed with. The message is unchanged (it is what the UI
 * shows); the status is what code must READ to tell an answer from a failure to get one — the
 * difference between "the server does not hold this session" (404) and "the server could not look"
 * (503), which `web/src/lib/unknownSessions.ts` acts on (E52).
 */
export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HttpError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    // 503 is "busy, try again" (a terminal UI holding the shared database for a moment): a short
    // retry turns it into a slower answer instead of a failed click.
    if (res.status !== 503 || attempt >= 4) break;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  // The answer's `Date` header is the server's own clock: the one every timestamp in the payloads
  // belongs to. The shared clock learns the offset so a device clock that is wrong cannot turn
  // into an age that is wrong (E53).
  const date = res.headers.get("date");
  if (date) ageClock.learnServerTime(Date.parse(date));
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error) message = parsed.error;
    } catch {
      if (text.trim()) message = text.trim().slice(0, 200);
    }
    throw new HttpError(message, res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  /** The agents' browser: its tabs (available=false when no cu daemon runs). */
  browserTabs: () => call<{ available: boolean; tabs: CuTab[] }>("/browser/tabs"),
  /** The human's input on a tab (tap, scroll, type, press), while they hold control. */
  browserInput: (tab: string, body: Record<string, unknown>) => call<{ ok: boolean }>(`/browser/tabs/${encodeURIComponent(tab)}/input`, { method: "POST", body: JSON.stringify(body) }),
  /** The work queue: the chat's session id and every task. */
  queue: () => call<QueueView>("/queue"),
  /** A message to the queue's one chat (creates it on the first message). */
  queuePrompt: (prompt: string, model?: string, attachments?: AttachmentRef[]) =>
    call<WireSession>("/queue/prompt", { method: "POST", body: JSON.stringify({ prompt, model, attachments }) }),
  queueNew: () => call<{ ok: true }>("/queue/new", { method: "POST" }),
  queueBrowserDone: (id: string) => call<{ ok: boolean }>(`/queue/tasks/${encodeURIComponent(id)}/browser-done`, { method: "POST" }),
  queueCancel: (id: string) => call<{ ok: boolean; text: string }>(`/queue/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  queueRedirect: (id: string, message: string) =>
    call<{ ok: boolean; text: string }>(`/queue/tasks/${encodeURIComponent(id)}/redirect`, { method: "POST", body: JSON.stringify({ message }) }),
  /** A session's agent tree, the messages between its agents, and the agent definitions. */
  /** `init` lets a caller carry its own deadline: a poll that is abandoned must be abortable. */
  agents: (id: string, init?: RequestInit) => call<AgentsView>(`/sessions/${encodeURIComponent(id)}/agents`, init),
  /** The tree alone (`?brief=1`): the sidebar renders the rows and drops `events` + `defs` — on
   *  the deployed surface the full answer was 34 407 B for 2 rows, 93% of it `defs` (E55). */
  agentsBrief: (id: string, init?: RequestInit) => call<AgentsBrief>(`/sessions/${encodeURIComponent(id)}/agents?brief=1`, init),
  agentDefs: () => call<AgentDef[]>("/agents"),
  /** Subfolders of `path` on this machine (`hostId` empty or "local") or on a saved remote host. */
  folders: (path: string, hostId = "local") =>
    call<FolderListing>(`/folders?${new URLSearchParams({ path, ...(hostId && hostId !== "local" ? { hostId } : {}) })}`),
  sessions: () => call<SessionMeta[]>("/sessions"),
  /** Every bot's kanban cards (`mini-tui kanban`), newest first. */
  kanban: () => call<{ id: string; session: string; title: string; description: string; column: string; assignee: string; result: string; updatedAt: number }[]>("/kanban"),
  /**
   * Whether the server still knows this session — a QUESTION, and it opens nothing.
   *
   * There is deliberately no "read this session" call here: the route that would answer it
   * (`GET /sessions/:id`) answers by OPENING the session — it restores the saved row into a live
   * session, puts it back on the durable open list (`web_open_sessions`) and announces it to every
   * tab. So a client that merely wondered whether a session was still there brought a CLOSED
   * session back to life, and the next deploy kept it open (E52/E56). This route only reads.
   */
  sessionExists: (id: string) => call<{ exists: boolean }>(`/sessions/${encodeURIComponent(id)}/exists`),
  create: (body: CreateSessionBody) =>
    call<WireSession>("/sessions", { method: "POST", body: JSON.stringify(body) }),
  send: (id: string, prompt: string, attachments?: AttachmentRef[]) =>
    call<{ ok: true }>(`/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ prompt, attachments }) }),
  setModel: (id: string, model: string) =>
    call<{ ok: true }>(`/sessions/${id}/model`, { method: "POST", body: JSON.stringify({ model }) }),
  /** v5-A: rename a session at any time (the sidebar's pencil / double-click). */
  setTitle: (id: string, title: string) =>
    call<{ ok: true }>(`/sessions/${id}/title`, { method: "POST", body: JSON.stringify({ title }) }),
  interrupt: (id: string) => call<{ ok: true }>(`/sessions/${id}/interrupt`, { method: "POST" }),
  close: (id: string) => call<{ ok: true }>(`/sessions/${id}`, { method: "DELETE" }),
  history: (query = "", limit = 50, cwd?: string) =>
    call<HistoryItem[]>(`/history?${new URLSearchParams({ ...(query.trim() ? { q: query.trim() } : {}), limit: String(limit), ...(cwd !== undefined ? { cwd } : {}) })}`),
  historyFolders: () => call<FolderSummary[]>("/history/folders"),
  openHistory: (id: string) => call<WireSession>(`/history/${id}`, { method: "POST" }),
  deleteHistory: (id: string) => call<{ ok: true }>(`/history/${id}`, { method: "DELETE" }),
  hosts: () => call<RemoteHost[]>("/hosts"),
  saveHost: (host: RemoteHost) =>
    call<RemoteHost>("/hosts", { method: "PUT", body: JSON.stringify(host) }),
  deleteHost: (id: string) => call<{ ok: true }>(`/hosts/${id}`, { method: "DELETE" }),
  probeHost: (host: RemoteHost, signal?: AbortSignal) =>
    call<{ ok: boolean; message: string; agent: boolean; version?: string }>("/hosts/probe", {
      method: "POST",
      body: JSON.stringify(host),
      signal,
    }),
  models: () => call<ModelInfo[]>("/models"),
  commands: () => call<CommandInfo[]>("/commands"),
  skills: () => call<SkillInfo[]>("/skills"),
  compact: (id: string) => call<{ ok: true }>(`/sessions/${id}/compact`, { method: "POST" }),
  settings: () => call<SettingsView>("/settings"),
  patchSettings: (patch: Record<string, unknown>) => call<SettingsView>("/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  // v6-C: the router's own status and decision trail. Read-only — the toggle is
  // `patchSettings({ modelRouterEnabled })`, the same act as `/router on|off`.
  router: (limit = 25, level?: RouteLevel) =>
    call<RouterStatusView>(`/router?limit=${limit}${level ? `&level=${level}` : ""}`),
  // A dry run of the real decision path, so the preview is the thing itself.
  routerPreview: (task: string) => call<RouterPreview>(`/router/preview`, { method: "POST", body: JSON.stringify({ task }) }),
  // Forget a cooldown so a tripped model can be tried again now.
  routerResetBreaker: (model: string) => call<{ ok: true; model: string }>(`/router/breaker/${encodeURIComponent(model)}`, { method: "DELETE" }),
  providers: () => call<{ connected: ProviderView[]; catalog: ProviderCatalogEntry[] }>("/providers"),
  // A 400 here is an expected answer ("that key did not work"), not a transport failure.
  connectProvider: async (providerId: string, key: string): Promise<ConnectResult> => {
    const res = await fetch("/api/providers/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId, key }),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<ConnectResult> & { error?: string };
    if (body && "ok" in body && body.ok !== undefined) return body as ConnectResult;
    return { ok: false, error: body.error ?? `${res.status} ${res.statusText}` };
  },
  // Re-ask the provider's /models with the saved base URL and key. Failures come back as { ok: false }.
  refetchModels: async (id: string): Promise<ConnectResult> => {
    const res = await fetch(`/api/providers/${encodeURIComponent(id)}/refetch`, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as Partial<ConnectResult> & { error?: string };
    if (body && "ok" in body && body.ok !== undefined) return body as ConnectResult;
    return { ok: false, error: body.error ?? `${res.status} ${res.statusText}` };
  },
  disconnectProvider: (id: string) => call<{ ok: true }>(`/providers/${id}`, { method: "DELETE" }),
  /** MCP servers: installed ones (masked) and the one-click presets. */
  mcp: () => call<{ servers: McpServerView[]; presets: McpPreset[] }>("/mcp"),
  mcpAdd: (body: { preset?: string; url?: string; name?: string; clientName?: string; clientId?: string; clientSecret?: string; headers?: Record<string, string> }) =>
    call<{ server: McpServerView; probe: McpProbe }>("/mcp", { method: "POST", body: JSON.stringify(body) }),
  mcpRemove: (id: string) => call<{ ok: true }>(`/mcp/${id}`, { method: "DELETE" }),
  mcpSetDisabled: (id: string, disabled: boolean) => call<{ server: McpServerView }>(`/mcp/${id}`, { method: "PATCH", body: JSON.stringify({ disabled }) }),
  mcpTest: (id: string) => call<{ server: McpServerView; probe: McpProbe & { tools: { name: string; description?: string }[] } }>(`/mcp/${id}/test`, { method: "POST" }),
  mcpLogout: (id: string) => call<{ server: McpServerView }>(`/mcp/${id}/logout`, { method: "POST" }),
  mcpLogin: (id: string) => call<{ login: McpLogin }>(`/mcp/${id}/login`, { method: "POST" }),
  mcpLoginState: (loginId: string) => call<{ login: McpLogin }>(`/mcp/logins/${loginId}`),
  mcpLoginPaste: (loginId: string, text: string) => call<{ login: McpLogin }>(`/mcp/logins/${loginId}/paste`, { method: "POST", body: JSON.stringify({ text }) }),
  mcpLoginCancel: (loginId: string) => call<{ ok: true }>(`/mcp/logins/${loginId}`, { method: "DELETE" }),
};

/**
 * "Was that refused handshake a deleted session, or just a dead network?"
 *
 * `false` = the server says the id is nowhere (it is gone); `true` = it is there; `null` = could not
 * tell (the network, a busy database), so the caller keeps trying.
 *
 * THE VERDICT IS READ FROM THE BODY, NEVER FROM THE STATUS. A route that answered "nowhere" with a
 * 404 would be indistinguishable from a 404 that means "this server has no such route" -- which is
 * exactly what a bundle NEWER than its server meets, because the bundle is served from disk and the
 * server is restarted separately (the client ships with `bun run build`, the server with a restart).
 * The old code read the status and so mistook the routing 404 for the answer, and the browser
 * concluded a LIVE session was gone and turned its pane into a new chat: the E52 symptom, back
 * through the other door. So the route answers 200 with `{exists:true|false}` and EVERY other
 * outcome -- a routing 404, a 503 from a busy database, the network -- is a failure to ASK, never
 * an answer, and must never forget a session (E52).
 *
 * The question is asked through the READ-ONLY route on purpose. `GET /sessions/:id` answers it by
 * OPENING the session -- restoring the saved row, putting the id back on the durable open list
 * (`web_open_sessions`) and announcing it to every tab -- so asking whether a closed session was
 * still there brought it back to life (E52/E56).
 */
export async function sessionExists(id: string): Promise<boolean | null> {
  try {
    const answer = await api.sessionExists(id);
    // Only a body that SAYS so is an answer. A 200 with anything else is a failure to ask.
    return typeof answer?.exists === "boolean" ? answer.exists : null;
  } catch {
    return null;
  }
}
