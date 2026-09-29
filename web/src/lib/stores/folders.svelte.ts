/**
 * Data for the sidebar's "By folder" view. The folder list (with counts) is one cheap request. A
 * folder's saved sessions are fetched the first time it is expanded, 20 at a time, and never polled:
 * everything is re-read only when the set of sessions changes (one started, finished, closed or was
 * deleted), which the sidebar signals by calling `refresh()`.
 */
import { api } from "../api";
import type { FolderSummary, HistoryItem } from "../types";

const PAGE = 20;

class FolderStore {
  folders = $state<FolderSummary[]>([]);
  status = $state<"idle" | "loading" | "ready" | "error">("idle");
  /** Saved sessions loaded per folder. */
  items = $state<Record<string, HistoryItem[]>>({});
  limit = $state<Record<string, number>>({});
  loading = $state<Record<string, boolean>>({});
  #inflight = false;

  async load() {
    if (this.#inflight) return;
    this.#inflight = true;
    if (this.status === "idle") this.status = "loading";
    try {
      this.folders = await api.historyFolders();
      this.status = "ready";
    } catch {
      if (this.status !== "ready") this.status = "error";
    } finally {
      this.#inflight = false;
    }
  }

  /** Load (or re-load) one folder's saved sessions; `more` asks for the next page. */
  async open(cwd: string, more = false) {
    if (this.loading[cwd]) return;
    const limit = more ? (this.limit[cwd] ?? PAGE) + PAGE : (this.limit[cwd] ?? PAGE);
    this.loading[cwd] = true;
    try {
      const rows = await api.history("", limit, cwd);
      this.items[cwd] = rows;
      this.limit[cwd] = limit;
    } catch {
      /* keep what is shown */
    } finally {
      this.loading[cwd] = false;
    }
  }

  /**
   * Sessions in `cwds` changed (one started, finished, was closed): re-read the folder list (counts)
   * and just those folders, if they have been opened. Other folders are untouched: nothing in them moved.
   */
  async refresh(cwds: string[] = Object.keys(this.items)) {
    await this.load();
    await Promise.all([...new Set(cwds)].filter((cwd) => cwd in this.items).map((cwd) => this.open(cwd)));
  }

  loaded(cwd: string): boolean {
    return cwd in this.items;
  }
  hasMore(cwd: string, total: number): boolean {
    return (this.items[cwd]?.length ?? 0) < total && (this.items[cwd]?.length ?? 0) >= (this.limit[cwd] ?? PAGE);
  }
  remove(id: string) {
    for (const cwd of Object.keys(this.items)) this.items[cwd] = this.items[cwd]!.filter((i) => i.id !== id);
  }
}

export const folderStore = new FolderStore();
