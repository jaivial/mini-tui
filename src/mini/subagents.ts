/**
 * Subagents a session's Rust agent started (`mini-agent-rs agent spawn`), as mini-tui sessions.
 *
 * The agent lists its children in `<run dir>/subagents/index.json` (name, state, trajectory,
 * control file, pid). This turns each into a session of its own with `parent_id` set, keeps its
 * transcript saved like any session's, and announces its live agent in `live_runs`, so the web app
 * and the TUI show it under its parent and can open it, follow it live and message it (the same
 * attach path a session running in another UI uses).
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";

import { clearLiveRun, registerLiveRun, saveTranscript, upsertSubagentSession } from "../sessions";
import { messagesToEvents, parseInfo } from "../traj/parse";
import { boundEvent, slimMessage } from "../traj/slim";
import { readTrajectory } from "../traj/watch";

export interface SubagentEntry {
  name: string;
  state: string;
  exit_status: string;
  task: string;
  cwd: string;
  model: string;
  steps: number;
  cost: number;
  turns: number;
  pid: number;
  traj_path: string;
  control_path: string;
  idle_s: number;
  last_command: string;
  /** Last sampled RSS of the child's process group (MiB). */
  mem_rss: number;
  /** Its rolling mean and peak (MiB): what a new child is charged for. */
  mem_avg: number;
  mem_peak: number;
}

/** What the UIs show of a subagent. */
export interface SubagentView {
  name: string;
  sessionId: string;
  state: string;
  exitStatus: string;
  steps: number;
  cost: number;
  task: string;
  lastCommand: string;
  /** Now, rolling mean and peak of the child's memory (MiB): the fan-out budget it is spending. */
  memRss: number;
  memAvg: number;
  memPeak: number;
}

/** Whether the cached roster of `trajPath` is current (no file was re-read for it). */
export function subagentIndexFresh(trajPath: string): boolean {
  const path = subagentIndexPath(trajPath);
  const hit = indexCache.get(path);
  if (!hit) return false;
  try {
    const st = statSync(path);
    return hit.stamp === `${st.mtimeMs}:${st.size}` && Date.now() - hit.at < 1000;
  } catch {
    return false;
  }
}

export function subagentIndexPath(trajPath: string): string {
  return join(dirname(trajPath), "subagents", "index.json");
}

/**
 * Parsed `index.json` per path, keyed by its mtime: a hub that has not changed its roster is read
 * once a second per session, and at 100 children parsing it again is pure waste. An unchanged file
 * is a single `stat`.
 */
const indexCache = new Map<string, { stamp: string; entries: SubagentEntry[]; at: number }>();

export function readSubagentIndex(trajPath: string): SubagentEntry[] {
  const path = subagentIndexPath(trajPath);
  let stamp = "";
  try {
    // mtime alone is millisecond-granular: two writes in the same tick look unchanged. The size
    // catches a roster that changed shape, and a same-size change lands on a later mtime.
    const st = statSync(path);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    indexCache.delete(path);
    return [];
  }
  const hit = indexCache.get(path);
  if (hit && hit.stamp === stamp) {
    // A roster that really changed is written by the hub within a tick; anything older than a
    // second is re-read, so a same-size, same-millisecond write can never be missed for long.
    if (Date.now() - hit.at < 1000) return hit.entries;
  }
  let entries: SubagentEntry[] = [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    entries = Array.isArray(data?.children) ? (data.children as SubagentEntry[]) : [];
  } catch {
    return [];
  }
  indexCache.set(path, { stamp, entries, at: Date.now() });
  return entries;
}

/** A child's session id: stable per parent and name, so a restart or a resync never duplicates it. */
export function subagentSessionId(parentId: string, name: string): string {
  return `${parentId}~${name}`;
}

export function toView(parentId: string, entry: SubagentEntry): SubagentView {
  return {
    name: entry.name,
    sessionId: subagentSessionId(parentId, entry.name),
    state: entry.state,
    exitStatus: entry.exit_status,
    steps: entry.steps,
    cost: entry.cost,
    task: entry.task,
    lastCommand: entry.last_command,
    memRss: entry.mem_rss ?? 0,
    memAvg: entry.mem_avg ?? 0,
    memPeak: entry.mem_peak ?? 0,
  };
}

/**
 * Keep the parent's children in the database: one session each (`parent_id` = the parent), its
 * transcript saved when its journal changed, its live agent announced while it runs. Returns the
 * views for the UI. `seen` remembers each journal's mtime, so an idle child costs one `stat`.
 */
export class SubagentSync {
  #seen = new Map<string, string>();
  #announced = new Map<string, string>();
  /** The last row written for a child, so an unchanged one is not written again. */
  #rows = new Map<string, string>();

  constructor(private readonly db: () => Database) {}

  sync(parentId: string, trajPath: string): SubagentView[] {
    const entries = readSubagentIndex(trajPath);
    if (!entries.length) return [];
    const views: SubagentView[] = [];
    for (const entry of entries) {
      const id = subagentSessionId(parentId, entry.name);
      views.push(toView(parentId, entry));
      try {
        // The session row only changes when the roster entry itself does: a child that is only
        // ticking its cost or state changes the transcript below, not this row. At 100 children
        // this is the difference between 100 writes a second and none.
        const rowKey = `${entry.cwd}${entry.model}${entry.task}`;
        if (this.#rows.get(id) !== rowKey) {
          upsertSubagentSession(this.db(), {
            id,
            parentId,
            title: `${entry.name} · ${firstLine(entry.task)}`,
            cwd: entry.cwd,
            model: entry.model,
            task: entry.task,
          });
          this.#rows.set(id, rowKey);
        }
        this.#saveTranscript(id, entry.traj_path);
        this.#announce(id, entry);
      } catch {
        // best-effort: the next sync tries again
      }
    }
    return views;
  }

  #saveTranscript(id: string, trajPath: string): void {
    const journal = trajPath.replace(/\.json$/, ".jsonl");
    // One `stat`, not an `existsSync` plus a `statSync`: at 100 children that is 100 fewer syscalls
    // every second, and the mtime is what decides whether anything is read at all.
    let stamp = "";
    try {
      const st = statSync(journal);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      try {
        const st = statSync(trajPath);
        stamp = `${st.mtimeMs}:${st.size}`;
      } catch {
        return;
      }
    }
    if (this.#seen.get(id) === stamp) return;
    const traj = readTrajectory(trajPath);
    if (!traj) return;
    this.#seen.set(id, stamp);
    const messages = traj.messages ?? [];
    const events = messagesToEvents(messages, {}, 0).map(boundEvent);
    saveTranscript(this.db(), id, events, parseInfo(traj), messages.map(slimMessage));
  }

  /** While its process holds its control file, any UI can attach to it like to a terminal's agent. */
  #announce(id: string, entry: SubagentEntry): void {
    const alive = entry.pid > 0 && (entry.state === "running" || entry.state === "starting" || entry.state === "waiting");
    const key = alive ? `${entry.pid}:${entry.traj_path}` : "";
    if (this.#announced.get(id) === key) return;
    if (alive) {
      registerLiveRun(this.db(), { session_id: id, traj_path: entry.traj_path, control_path: entry.control_path, pid: entry.pid, owner: "subagent" });
    } else if (this.#announced.has(id)) {
      clearLiveRun(this.db(), id, entry.traj_path);
    }
    this.#announced.set(id, key);
  }
}

function firstLine(text: string): string {
  const line = (text ?? "").trim().split("\n")[0]?.trim() ?? "";
  return line.length <= 60 ? line : `${line.slice(0, 59)}…`;
}
