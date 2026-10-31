/**
 * Saved workspaces: named folders the user creates sessions in when the main chat is in manual
 * mode (`chatMode: "manual"`). One JSON file shared by the web server and the terminal UI, so a
 * workspace added in one shows up in the other.
 *
 * A workspace is a folder on this machine (`hostId` absent) or on a saved remote host (`hostId`
 * from `web-hosts.json`). Sessions are not stored here: they belong to a workspace by their cwd
 * (and host), so a session started in that folder from anywhere is listed under it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export interface SavedWorkspace {
  id: string;
  name: string;
  /** Absolute path for a local workspace; the path as typed (may start with `~`) on a remote host. */
  path: string;
  /** A saved remote host's id; absent = this machine. */
  hostId?: string;
  createdAt: number;
  updatedAt: number;
}

export const MAX_WORKSPACES = 200;
const NAME_MAX = 80;
const PATH_MAX = 4096;

export class WorkspaceError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/**
 * `MINITUI_WORKSPACES_PATH` wins, then `MINITUI_CONFIG_DIR`. Under test with neither set there is
 * no file at all (reads are empty, writes stay in memory), the same rule `settings.ts` follows so
 * the suite never touches the developer's home.
 */
export function workspacesFile(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.MINITUI_WORKSPACES_PATH) return env.MINITUI_WORKSPACES_PATH;
  if (env.MINITUI_CONFIG_DIR) return join(env.MINITUI_CONFIG_DIR, "workspaces.json");
  if (env.NODE_ENV === "test" || env.MINITUI_TEST === "1") return null;
  return join(homedir(), ".config", "mini-tui", "workspaces.json");
}

let memory: SavedWorkspace[] = [];

function valid(w: unknown): w is SavedWorkspace {
  const r = w as SavedWorkspace;
  return !!r && typeof r.id === "string" && typeof r.name === "string" && typeof r.path === "string" && (r.hostId === undefined || typeof r.hostId === "string");
}

export function listWorkspaces(): SavedWorkspace[] {
  const file = workspacesFile();
  if (!file) return memory.map((w) => ({ ...w }));
  try {
    if (!existsSync(file)) return [];
    const data = JSON.parse(readFileSync(file, "utf8")) as { workspaces?: unknown };
    const list = Array.isArray(data?.workspaces) ? data.workspaces : [];
    return list.filter(valid).slice(0, MAX_WORKSPACES).map((w) => ({
      id: w.id,
      name: w.name,
      path: w.path,
      ...(w.hostId ? { hostId: w.hostId } : {}),
      createdAt: typeof w.createdAt === "number" ? w.createdAt : 0,
      updatedAt: typeof w.updatedAt === "number" ? w.updatedAt : 0,
    }));
  } catch {
    return [];
  }
}

function save(list: SavedWorkspace[]): void {
  const file = workspacesFile();
  if (!file) {
    memory = list.map((w) => ({ ...w }));
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  // Write then rename: a crash mid-write never leaves a half file that would read as empty.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, workspaces: list }, null, 2)}\n`);
  renameSync(tmp, file);
}

export function expandHome(input: string, home = homedir()): string {
  const raw = input.trim();
  if (!raw || raw === "~") return home;
  if (raw.startsWith("~/")) return join(home, raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : resolve(home, raw);
}

function cleanName(name: unknown, path: string): string {
  const n = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
  return (n || basename(path.replace(/\/+$/, "")) || path).slice(0, NAME_MAX);
}

export interface WorkspaceInput {
  name?: unknown;
  path?: unknown;
  hostId?: unknown;
}

/**
 * Add a workspace, or return the existing one for the same folder on the same host (renamed when
 * a new name is given). A local folder must exist; a remote one is checked by the caller, which
 * knows the saved hosts.
 */
export function addWorkspace(input: WorkspaceInput, knownHost?: (id: string) => boolean): SavedWorkspace {
  const rawPath = typeof input.path === "string" ? input.path : "";
  if (!rawPath.trim()) throw new WorkspaceError("a workspace needs a folder");
  if (rawPath.length > PATH_MAX || rawPath.includes("\0")) throw new WorkspaceError("invalid path");
  const hostId = typeof input.hostId === "string" && input.hostId && input.hostId !== "local" ? input.hostId : undefined;
  let path: string;
  if (hostId) {
    if (knownHost && !knownHost(hostId)) throw new WorkspaceError("unknown remote host", 404);
    path = rawPath.trim().replace(/(.)\/+$/, "$1");
  } else {
    path = expandHome(rawPath);
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new WorkspaceError(`${path} is not a folder on this machine`);
  }
  const list = listWorkspaces();
  const now = Date.now();
  const existing = list.find((w) => w.path === path && (w.hostId ?? "") === (hostId ?? ""));
  if (existing) {
    if (typeof input.name === "string" && input.name.trim()) {
      existing.name = cleanName(input.name, path);
      existing.updatedAt = now;
      save(list);
    }
    return existing;
  }
  if (list.length >= MAX_WORKSPACES) throw new WorkspaceError(`at most ${MAX_WORKSPACES} workspaces`);
  const ws: SavedWorkspace = { id: `w-${now.toString(36)}${randomBytes(3).toString("hex")}`, name: cleanName(input.name, path), path, ...(hostId ? { hostId } : {}), createdAt: now, updatedAt: now };
  list.push(ws);
  save(list);
  return ws;
}

export function renameWorkspace(id: string, name: unknown): SavedWorkspace {
  const list = listWorkspaces();
  const ws = list.find((w) => w.id === id);
  if (!ws) throw new WorkspaceError("no such workspace", 404);
  if (typeof name !== "string" || !name.trim()) throw new WorkspaceError("a name is required");
  ws.name = cleanName(name, ws.path);
  ws.updatedAt = Date.now();
  save(list);
  return ws;
}

export function removeWorkspace(id: string): boolean {
  const list = listWorkspaces();
  const next = list.filter((w) => w.id !== id);
  if (next.length === list.length) return false;
  save(next);
  return true;
}

/** The saved workspace a session belongs to: the deepest workspace folder that contains its cwd. */
export function workspaceForCwd(list: SavedWorkspace[], cwd: string, hostId?: string): SavedWorkspace | undefined {
  const norm = (p: string) => p.replace(/(.)\/+$/, "$1");
  const c = norm(cwd);
  let best: SavedWorkspace | undefined;
  for (const w of list) {
    if ((w.hostId ?? "") !== (hostId ?? "")) continue;
    const p = norm(w.path);
    if (c === p || c.startsWith(p === "/" ? "/" : `${p}/`)) {
      if (!best || p.length > norm(best.path).length) best = w;
    }
  }
  return best;
}
