/** Thin fetch wrapper around the mini-tui web server. */
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
  SessionMeta,
  SettingsView,
  SkillInfo,
  WireSession,
} from "./types";

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
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error) message = parsed.error;
    } catch {
      if (text.trim()) message = text.trim().slice(0, 200);
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  /** Subfolders of `path` on this machine (`hostId` empty or "local") or on a saved remote host. */
  folders: (path: string, hostId = "local") =>
    call<FolderListing>(`/folders?${new URLSearchParams({ path, ...(hostId && hostId !== "local" ? { hostId } : {}) })}`),
  sessions: () => call<SessionMeta[]>("/sessions"),
  session: (id: string) => call<WireSession>(`/sessions/${id}`),
  create: (body: CreateSessionBody) =>
    call<WireSession>("/sessions", { method: "POST", body: JSON.stringify(body) }),
  send: (id: string, prompt: string) =>
    call<{ ok: true }>(`/sessions/${id}/prompt`, { method: "POST", body: JSON.stringify({ prompt }) }),
  setModel: (id: string, model: string) =>
    call<{ ok: true }>(`/sessions/${id}/model`, { method: "POST", body: JSON.stringify({ model }) }),
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
  probeHost: (host: RemoteHost) =>
    call<{ ok: boolean; message: string; agent: boolean; version?: string }>("/hosts/probe", {
      method: "POST",
      body: JSON.stringify(host),
    }),
  models: () => call<ModelInfo[]>("/models"),
  commands: () => call<CommandInfo[]>("/commands"),
  skills: () => call<SkillInfo[]>("/skills"),
  compact: (id: string) => call<{ ok: true }>(`/sessions/${id}/compact`, { method: "POST" }),
  settings: () => call<SettingsView>("/settings"),
  patchSettings: (patch: Record<string, unknown>) => call<SettingsView>("/settings", { method: "PATCH", body: JSON.stringify(patch) }),
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
  disconnectProvider: (id: string) => call<{ ok: true }>(`/providers/${id}`, { method: "DELETE" }),
};
