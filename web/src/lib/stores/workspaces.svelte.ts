/**
 * Saved workspaces (manual chat mode): the list, live through the shared stream's `workspaces`
 * pushes, and each workspace's saved sessions (one read for all of them, re-read only when
 * something in the sidebar moved).
 */
import { api, HttpError } from "../api";
import { store } from "./sessions.svelte";
import type { HistoryItem, SavedWorkspace } from "../types";

const SAVED_PER_WORKSPACE = 30;

class WorkspacesStore {
  list = $state<SavedWorkspace[]>([]);
  status = $state<"idle" | "loading" | "ready" | "error">("idle");
  /** Saved sessions per workspace id, newest first. */
  saved = $state<Record<string, HistoryItem[]>>({});
  /** This machine's home folder, so a local path shows as `~/...`. */
  home = $state("");
  #off: (() => void) | null = null;

  #listen() {
    this.#off ??= store.onEvent("workspaces", (event) => {
      if (event.workspaces) this.#apply(event.workspaces);
    });
  }

  #apply(list: SavedWorkspace[]) {
    this.list = list;
    this.status = "ready";
    const ids = new Set(list.map((w) => w.id));
    for (const id of Object.keys(this.saved)) if (!ids.has(id)) delete this.saved[id];
  }

  async load() {
    this.#listen();
    if (!this.home) void api.folders("~").then((l) => (this.home = l.home), () => {});
    if (this.status === "idle") this.status = "loading";
    try {
      this.#apply((await api.workspaces()).workspaces);
    } catch (error) {
      if (this.status !== "ready") this.status = "error";
      throw error;
    }
  }

  byId(id: string): SavedWorkspace | undefined {
    return this.list.find((w) => w.id === id);
  }

  /** Re-read the saved sessions of every workspace. */
  async refreshSaved() {
    let all: Record<string, HistoryItem[]>;
    try {
      all = await api.workspaceSessions(SAVED_PER_WORKSPACE);
    } catch (error) {
      // The bundle is deployed apart from the server: one older than this bundle has no such
      // route, and its exact-folder history is the closest it can answer.
      if (error instanceof HttpError && error.status === 404) await this.#refreshByFolder();
      return; // anything else: keep what is shown
    }
    for (const w of this.list) this.saved[w.id] = all[w.id] ?? [];
  }

  async #refreshByFolder() {
    await Promise.all(
      this.list.map(async (w) => {
        try {
          this.saved[w.id] = await api.history("", SAVED_PER_WORKSPACE, w.path);
        } catch {
          /* keep what is shown */
        }
      }),
    );
  }

  async add(body: { name?: string; path: string; hostId?: string }): Promise<SavedWorkspace> {
    this.#listen();
    const created = await api.addWorkspace(body);
    if (!this.list.some((w) => w.id === created.id)) this.list = [...this.list, created];
    else this.list = this.list.map((w) => (w.id === created.id ? created : w));
    return created;
  }

  async rename(id: string, name: string) {
    const renamed = await api.renameWorkspace(id, name);
    this.list = this.list.map((w) => (w.id === id ? renamed : w));
  }

  async remove(id: string) {
    await api.deleteWorkspace(id);
    this.#apply(this.list.filter((w) => w.id !== id));
  }
}

export const workspaces = new WorkspacesStore();
