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
} from "./types";

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
  session: (id: string) => call<WireSession>(`/sessions/${id}`),
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
};
