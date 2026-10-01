/**
 * The web app's shared workspace: the windows, their panes, which session each pane shows, and the
 * sidebar's preferences. It lives on the server (one JSON file), so every device, browser and tab
 * shows the same thing. It travels over the socket hub like notes: a tab watches it, is sent the
 * current value at once, and gets every change made anywhere else pushed as it happens.
 *
 * The document is opaque here (the browser owns its shape); the server only versions it, bounds its
 * size and refuses a save that started from an older version, answering with the current one so the
 * client adopts it instead of overwriting a newer layout with a stale one.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Workspace {
  /** 0 = nothing saved yet: the first tab to connect seeds it with what it has. */
  version: number;
  doc: unknown;
  updatedAt: number;
}

export type SaveWorkspaceResult = { ok: true; workspace: Workspace } | { ok: false; current: Workspace };

/** A layout of 12 panes in many windows is a few KB; this only stops abuse. */
export const WORKSPACE_MAX = 512 * 1024;

export class WorkspaceStore {
  #current: Workspace | null = null;
  constructor(private readonly path: string) {}

  get(): Workspace {
    if (this.#current) return this.#current;
    try {
      if (existsSync(this.path)) {
        const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Workspace>;
        if (typeof raw.version === "number" && raw.version >= 0 && raw.doc !== undefined) {
          return (this.#current = { version: raw.version, doc: raw.doc, updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0 });
        }
      }
    } catch {
      /* unreadable: start empty, the next save rewrites it */
    }
    return (this.#current = { version: 0, doc: null, updatedAt: 0 });
  }

  /** Save `doc` if `base` is the current version. A stale base is refused with the current value. */
  save(doc: unknown, base: number): SaveWorkspaceResult {
    const current = this.get();
    if (base !== current.version) return { ok: false, current };
    const next: Workspace = { version: current.version + 1, doc, updatedAt: Date.now() };
    mkdirSync(dirname(this.path), { recursive: true });
    // Write then rename: a crash mid-write never leaves a half file that would read as empty.
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next));
    renameSync(tmp, this.path);
    this.#current = next;
    return { ok: true, workspace: next };
  }
}
