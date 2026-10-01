/**
 * The sidebar's "By folder" view, as pure logic: one group per folder, holding the open sessions in it
 * and the saved ones, most recently active folder first. Pinned folders stay on top in the order they
 * were pinned, and collapsed ones remember it. Both choices are kept in the browser.
 */
import type { FolderSummary, HistoryItem, SessionState } from "./types";

export interface FolderGroup {
  cwd: string;
  /** Sessions open in this server, newest first. */
  open: SessionState[];
  /** Saved sessions not open, newest first (as many as have been loaded for this folder). */
  saved: HistoryItem[];
  /** Saved sessions in the database for this folder (all of them, loaded or not). */
  total: number;
  updatedAt: number;
  pinned: boolean;
  running: number;
}

/** Group by exact folder. A trailing slash is the same folder; the root stays "/". */
export function normalizeCwd(cwd: string): string {
  const t = (cwd || "").trim();
  if (!t) return "";
  return t.length > 1 ? t.replace(/\/+$/, "") || "/" : t;
}

/**
 * Open sessions in a stable order: newest started first. Not by `updatedAt`, which moves on every
 * step of a running session, so live rows would keep swapping places under your pointer.
 */
export const byStart = (a: { createdAt: number; id: string }, b: { createdAt: number; id: string }) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function groupByFolder(
  open: SessionState[],
  saved: HistoryItem[],
  folders: FolderSummary[],
  pinned: string[] = [],
): FolderGroup[] {
  const map = new Map<string, FolderGroup>();
  const get = (cwd: string) => {
    const key = normalizeCwd(cwd);
    let g = map.get(key);
    if (!g) map.set(key, (g = { cwd: key, open: [], saved: [], total: 0, updatedAt: 0, pinned: pinned.includes(key), running: 0 }));
    return g;
  };
  for (const f of folders) {
    const g = get(f.cwd);
    g.total += f.count;
    g.updatedAt = Math.max(g.updatedAt, f.updatedAt);
  }
  const openIds = new Set(open.map((s) => s.id));
  for (const s of open) {
    const g = get(s.cwd);
    g.open.push(s);
    g.updatedAt = Math.max(g.updatedAt, s.updatedAt);
    if (s.status === "running") g.running++;
  }
  for (const h of saved) {
    if (openIds.has(h.id)) continue;
    const g = get(h.cwd);
    if (!g.saved.some((x) => x.id === h.id)) g.saved.push(h);
    g.updatedAt = Math.max(g.updatedAt, h.updatedAt);
  }
  for (const g of map.values()) {
    // Live sessions first, in the order they started (they step constantly, so `updatedAt` would
    // reshuffle them); the rest of the folder's open sessions newest first, as before.
    g.open.sort((a, b) => {
      const la = a.status === "running", lb = b.status === "running";
      if (la !== lb) return la ? -1 : 1;
      return la ? byStart(a, b) : b.updatedAt - a.updatedAt;
    });
    g.saved.sort((a, b) => b.updatedAt - a.updatedAt);
    // A session open in this server may not be saved yet (the count comes from the database).
    g.total = Math.max(g.total, g.saved.length + g.open.filter((s) => !saved.some((h) => h.id === s.id)).length);
  }
  const rank = (g: FolderGroup) => (g.pinned ? pinned.indexOf(g.cwd) : Number.POSITIVE_INFINITY);
  // Folders with live sessions come first, but among themselves they hold their place: ordering live
  // folders by `updatedAt` would make them trade places on every step. Newest started session wins.
  const started = (g: FolderGroup) => Math.max(0, ...g.open.filter((s) => s.status === "running").map((s) => s.createdAt));
  return [...map.values()].sort(
    (a, b) => rank(a) - rank(b) || b.running - a.running || (a.running && b.running ? started(b) - started(a) : b.updatedAt - a.updatedAt) || (a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0),
  );
}

/** `/home/me/work/api` -> `api` as the title, `~/work` as the dim context line under it. */
export function folderTitle(cwd: string, home = ""): { name: string; parent: string } {
  if (!cwd) return { name: "No folder", parent: "" };
  if (cwd === "/") return { name: "/", parent: "" };
  const tilde = home && home !== "/" && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
  if (tilde === "~") return { name: "~", parent: "" };
  const i = tilde.lastIndexOf("/");
  return { name: tilde.slice(i + 1), parent: i > 0 ? tilde.slice(0, i) : "/" };
}

// ---- remembered in this browser
const KEY = "minitui.sidebar";
export interface SidebarPrefs {
  view: "recent" | "folder";
  pinned: string[];
  /** Folders you opened or closed yourself, and which way: this wins over the default. */
  expanded: Record<string, boolean>;
}

/** Expanded? What you chose for this folder; otherwise open when it has open sessions or is pinned. */
export function isExpanded(g: Pick<FolderGroup, "cwd" | "open" | "pinned">, prefs: Pick<SidebarPrefs, "expanded">): boolean {
  const chosen = prefs.expanded[g.cwd];
  return chosen ?? (g.open.length > 0 || g.pinned);
}
export function loadPrefs(): SidebarPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<SidebarPrefs>;
    const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string").slice(0, 200) : []);
    const expanded: Record<string, boolean> = {};
    if (v.expanded && typeof v.expanded === "object") for (const [k, b] of Object.entries(v.expanded).slice(0, 500)) if (typeof b === "boolean") expanded[k] = b;
    return { view: v.view === "folder" ? "folder" : "recent", pinned: strings(v.pinned), expanded };
  } catch {
    return { view: "recent", pinned: [], expanded: {} };
  }
}
export function savePrefs(p: SidebarPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode */
  }
}
export function toggleIn(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}
