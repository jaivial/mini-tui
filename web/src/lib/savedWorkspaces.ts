/**
 * Manual chat mode, as pure logic: which saved workspace a session belongs to, the sessions each
 * workspace lists in the sidebar, and where this device was last (so a reload lands there again).
 */
import type { HistoryItem, SavedWorkspace, SessionStatus } from "./types";

const trimSlash = (p: string) => p.replace(/(.)\/+$/, "$1");

/**
 * The saved workspace a session belongs to: the deepest workspace folder on the same host that
 * contains its cwd. The same rule as the server's `workspaceForCwd` (src/workspaces.ts).
 */
export function workspaceForCwd<W extends Pick<SavedWorkspace, "path" | "hostId">>(list: W[], cwd: string, hostId?: string): W | undefined {
  const c = trimSlash(cwd || "");
  if (!c) return undefined;
  let best: W | undefined;
  for (const w of list) {
    if ((w.hostId ?? "") !== (hostId ?? "")) continue;
    const p = trimSlash(w.path);
    if (c === p || c.startsWith(p === "/" ? "/" : `${p}/`)) {
      if (!best || p.length > trimSlash(best.path).length) best = w;
    }
  }
  return best;
}

/** What a workspace row needs from a live session (a `SessionState` fits). */
export interface LiveSession {
  id: string;
  title: string;
  cwd: string;
  hostId?: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  role?: "dispatcher" | "worker";
  parentId?: string;
}

export type RowState = "working" | "done" | "error" | "idle";

export interface WorkspaceRow {
  id: string;
  title: string;
  updatedAt: number;
  state: RowState;
  /** The server holds it open (it streams); a saved one is opened on click. */
  live: boolean;
}

export interface WorkspaceGroup<W extends SavedWorkspace = SavedWorkspace> {
  workspace: W;
  rows: WorkspaceRow[];
  running: number;
}

function liveState(s: LiveSession): RowState {
  if (s.status === "running") return "working";
  if (s.status === "error") return "error";
  if (s.status === "done") return "done";
  return "idle";
}

function savedState(h: HistoryItem): RowState {
  const exit = (h.exitStatus || "").toLowerCase();
  if (!exit) return "idle";
  return /error|limit|fail/.test(exit) ? "error" : "done";
}

/**
 * One group per saved workspace, in the order they were saved, each with its sessions newest first:
 * the live sessions whose cwd belongs to it, then the saved ones loaded for its folder that are not
 * live. Queue sessions (the dispatcher and its workers) and subagents are not the user's own chats,
 * so they are left out, as is anything in `exclude`.
 */
export function groupWorkspaces<W extends SavedWorkspace>(
  workspaces: W[],
  live: LiveSession[],
  saved: Record<string, HistoryItem[]>,
  exclude: Iterable<string> = [],
): WorkspaceGroup<W>[] {
  const skip = new Set(exclude);
  const groups = workspaces.map((workspace) => ({ workspace, rows: [] as WorkspaceRow[], running: 0 }));
  const byId = new Map(groups.map((g) => [g.workspace.id, g]));
  const liveIds = new Set<string>();
  for (const s of live) {
    liveIds.add(s.id);
    if (skip.has(s.id) || s.role || s.parentId) continue;
    const ws = workspaceForCwd(workspaces, s.cwd, s.hostId);
    const g = ws && byId.get(ws.id);
    if (!g) continue;
    const state = liveState(s);
    if (state === "working") g.running++;
    g.rows.push({ id: s.id, title: s.title || "New session", updatedAt: s.updatedAt || s.createdAt, state, live: true });
  }
  for (const g of groups) {
    const seen = new Set(g.rows.map((r) => r.id));
    for (const h of saved[g.workspace.id] ?? []) {
      if (skip.has(h.id) || liveIds.has(h.id) || seen.has(h.id)) continue;
      seen.add(h.id);
      g.rows.push({ id: h.id, title: h.title || h.task || "Untitled session", updatedAt: h.updatedAt || h.createdAt, state: savedState(h), live: false });
    }
    g.rows.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return groups;
}

// ---- where this device was last
export const PLACE_KEY = "minitui.manual.place";

export interface ManualPlace {
  workspaceId: string;
  /** Empty: a new-session draft in that workspace. */
  sessionId: string;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function loadPlace(store: Storage | null = storage()): ManualPlace {
  try {
    const v = JSON.parse(store?.getItem(PLACE_KEY) ?? "{}") as Partial<ManualPlace>;
    return { workspaceId: typeof v.workspaceId === "string" ? v.workspaceId : "", sessionId: typeof v.sessionId === "string" ? v.sessionId : "" };
  } catch {
    return { workspaceId: "", sessionId: "" };
  }
}

export function savePlace(place: ManualPlace, store: Storage | null = storage()): void {
  try {
    store?.setItem(PLACE_KEY, JSON.stringify({ workspaceId: place.workspaceId, sessionId: place.sessionId }));
  } catch {
    /* private mode */
  }
}
