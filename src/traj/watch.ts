/**
 * Trajectory file access: one-shot reads plus a polling watcher.
 *
 * The vendored agent (`agent/`) writes an append-only journal next to the trajectory export:
 * `<traj>.jsonl` holds a meta line, one line per message and a fresh info line on every save —
 * O(1) per step per message and never torn. The watcher consumes only the new bytes each tick
 * (true O(delta)) and falls back to whole-file reads for trajectories from unpatched producers
 * (`DefaultAgent.save()` rewrites the whole JSON on every step, non-atomically: a mid-write
 * read keeps the last good snapshot and is retried on the next tick).
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";

import type { Trajectory, TrajectoryInfo, TrajectoryMessage } from "./schema";
import { POLL_MS } from "../config";

/** `<traj>.json` → `<traj>.jsonl`, mirroring Python's `Path.with_suffix(".jsonl")`. */
export function journalPathFor(trajPath: string): string {
  const dot = trajPath.lastIndexOf(".");
  const slash = Math.max(trajPath.lastIndexOf("/"), trajPath.lastIndexOf("\\"));
  return dot > slash ? `${trajPath.slice(0, dot)}.jsonl` : `${trajPath}.jsonl`;
}

interface JournalState {
  messages: TrajectoryMessage[];
  info: TrajectoryInfo | undefined;
  format: string | undefined;
  offset: number;
  tail: Buffer;
}

function newJournalState(): JournalState {
  return { messages: [], info: undefined, format: undefined, offset: 0, tail: Buffer.alloc(0) };
}

/** Consume new journal bytes into `state`. Returns true when messages/info changed. */
function consumeJournal(state: JournalState, journalPath: string): boolean {
  let size: number;
  try {
    size = statSync(journalPath).size;
  } catch {
    return false; // no journal (yet): the caller falls back to the full export
  }
  if (size < state.offset) {
    // truncated and rewritten (a new run reusing the path): replay from scratch
    Object.assign(state, newJournalState());
  }
  if (size === state.offset) return false;

  const fd = openSync(journalPath, "r");
  let chunk: Buffer;
  try {
    chunk = Buffer.alloc(size - state.offset);
    readSync(fd, chunk, 0, chunk.length, state.offset);
  } finally {
    closeSync(fd);
  }
  state.offset = size;

  // Only complete lines are consumed; a partial tail waits for the writer's next append.
  const data = Buffer.concat([state.tail, chunk]);
  const end = data.lastIndexOf(0x0a);
  if (end < 0) {
    state.tail = data;
    return false;
  }
  state.tail = data.subarray(end + 1);

  let changed = false;
  for (const line of data.subarray(0, end).toString("utf8").split("\n")) {
    if (!line) continue;
    let entry: { t?: string; m?: TrajectoryMessage; i?: TrajectoryInfo; trajectory_format?: string };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // never accept a torn line as content
    }
    if (entry.t === "msg" && entry.m) {
      state.messages.push(entry.m);
      changed = true;
    } else if (entry.t === "info" && entry.i) {
      state.info = entry.i;
      changed = true;
    } else if (entry.t === "meta") {
      state.format = entry.trajectory_format;
    }
  }
  return changed;
}

function journalTrajectory(state: JournalState): Trajectory {
  return { messages: state.messages, info: state.info, trajectory_format: state.format };
}

export function readTrajectory(path: string): Trajectory | null {
  // The journal is the freshest source when present (it survives crashes and throttled exports).
  const journal = journalPathFor(path);
  if (existsSync(journal)) {
    const state = newJournalState();
    consumeJournal(state, journal);
    if (state.messages.length || state.info) return journalTrajectory(state);
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" ? (data as Trajectory) : null;
  } catch {
    return null;
  }
}

export interface WatchOptions {
  intervalMs?: number;
}

export interface WatchHandle {
  stop(): void;
}

export function watchTrajectory(path: string, onSnapshot: (traj: Trajectory) => void, options: WatchOptions = {}): WatchHandle {
  const intervalMs = options.intervalMs ?? POLL_MS;
  const journal = journalPathFor(path);
  const state = newJournalState();
  let journalMode = false;
  let lastStamp = "";
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    if (journalMode || existsSync(journal)) {
      journalMode = true;
      if (consumeJournal(state, journal)) onSnapshot(journalTrajectory(state));
      return;
    }
    let stamp = "";
    try {
      const stat = statSync(path);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return; // not written yet
    }
    if (stamp === lastStamp) return;
    const traj = readTrajectory(path);
    if (traj === null) return; // mid-write: keep the last good snapshot
    lastStamp = stamp;
    onSnapshot(traj);
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
