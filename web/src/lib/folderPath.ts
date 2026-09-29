/** Pure helpers for the folder picker: display labels and "recent folders" memory. */
import type { HistoryItem } from "./types";

/** `/home/me/work/api` shown as `~/work/api` when `home` is `/home/me`. */
export function tildify(path: string, home: string): string {
  if (!home || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** The folder's own name for a compact button: `api`, `~`, `/`. */
export function folderLabel(path: string, home = ""): string {
  if (!path) return "Default folder";
  const t = tildify(path, home);
  if (t === "~" || t === "/") return t;
  return t.replace(/\/+$/, "").split("/").pop() || t;
}

/** Crumbs from the root (or `~`) down to `path`, each with the path it opens. */
export function crumbs(path: string, home: string): { label: string; path: string }[] {
  const underHome = !!home && home !== "/" && (path === home || path.startsWith(`${home}/`));
  const start = underHome ? home : "/";
  const out = [{ label: underHome ? "~" : "/", path: start }];
  const rest = path.slice(start.length).split("/").filter(Boolean);
  let at = start === "/" ? "" : start;
  for (const part of rest) {
    at = `${at}/${part}`;
    out.push({ label: part, path: at });
  }
  return out;
}

/** Folders chats recently ran in, newest first, without repeats: what you most likely want next. */
export function recentFolders(items: HistoryItem[], limit = 6): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const p = item.cwd?.trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

const RECENT_KEY = (target: string) => `minitui.recentFolders.${target || "local"}`;

/** Folders picked for new chats on `target` ("local" or a host id), newest first. */
export function loadRecent(target: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY(target)) ?? "[]");
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string" && p.startsWith("/")).slice(0, 6) : [];
  } catch {
    return [];
  }
}

export function rememberRecent(target: string, path: string): void {
  if (!path.startsWith("/")) return;
  try {
    const next = [path, ...loadRecent(target).filter((p) => p !== path)].slice(0, 6);
    localStorage.setItem(RECENT_KEY(target), JSON.stringify(next));
  } catch {
    /* private mode */
  }
}
