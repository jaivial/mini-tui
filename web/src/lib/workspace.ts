/**
 * The one shared workspace for this tab (see `workspaceClient.ts`). Stores read their starting
 * value from it and save through it. A copy is also kept in localStorage: it is only used when the
 * server cannot be reached at start, so an offline tab still opens on the last layout it knew. The
 * server's value always wins over it.
 */
import { hub } from "./hub";
import { WorkspaceClient, type WorkspaceDoc } from "./workspaceClient";

export const workspace = new WorkspaceClient(hub);

const CACHE = "minitui.workspace";

/** The value to start from: the server's, else the last one this browser saw. */
export function startingDoc(): WorkspaceDoc {
  if (workspace.ready && workspace.doc) return workspace.doc;
  try {
    return (JSON.parse(localStorage.getItem(CACHE) ?? "null") as WorkspaceDoc | null) ?? {};
  } catch {
    return {};
  }
}

/** Save a part, and keep the offline copy in step. */
export function savePart(part: keyof WorkspaceDoc, value: unknown) {
  workspace.save(part, value);
  cache();
}

/** Save several parts as one version (so no device sees one without the other). */
export function saveParts(parts: WorkspaceDoc) {
  workspace.saveParts(parts);
  cache();
}

function cache() {
  try {
    const doc = { ...(workspace.doc ?? {}) };
    localStorage.setItem(CACHE, JSON.stringify(doc));
  } catch {
    /* private mode */
  }
}

workspace.onRemote(() => cache());
