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
import { boundText, slimMessage } from "./slim";

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
  /** Text of the assistant message still being generated, per channel. */
  partial: { thinking: string; text: string };
}

function newJournalState(): JournalState {
  return {
    messages: [],
    info: undefined,
    format: undefined,
    offset: 0,
    tail: Buffer.alloc(0),
    partial: { thinking: "", text: "" },
  };
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
  // Copy the partial tail: a subarray would pin the whole (possibly many-MB) read buffer.
  state.tail = Buffer.from(data.subarray(end + 1));

  let changed = false;
  // Decode line by line: one string for the whole delta (tens of MB when a tool dumped a big
  // output, twice that as UTF-16) plus its split copies was the ingest's peak allocation.
  for (let start = 0; start < end; ) {
    let nl = data.indexOf(0x0a, start);
    if (nl < 0 || nl > end) nl = end;
    const line = data.toString("utf8", start, nl);
    start = nl + 1;
    if (!line) continue;
    let entry: {
      t?: string;
      m?: TrajectoryMessage;
      i?: TrajectoryInfo;
      k?: string;
      x?: string;
      trajectory_format?: string;
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // never accept a torn line as content
    }
    if (entry.t === "msg" && entry.m) {
      // Bound on the way in: a single tool result can be hundreds of MB (a `cat` of a big
      // dump, a noisy test run), and the retained array is what every later read, event
      // conversion and transcript save re-walks. The parse above is the transient peak;
      // this is what stops it being retained. Files on disk stay complete.
      const m = entry.m;
      if (typeof m.content === "string") {
        const bounded = boundText(m.content);
        state.messages.push(bounded === m.content ? m : { ...m, content: bounded });
      } else {
        state.messages.push(m);
      }
      // The real message supersedes whatever was streamed for it.
      if (state.partial.thinking || state.partial.text) {
        state.partial.thinking = "";
        state.partial.text = "";
      }
      changed = true;
    } else if (entry.t === "delta" && typeof entry.x === "string") {
      if (entry.k === "thinking") state.partial.thinking += entry.x;
      else if (entry.k === "text") state.partial.text += entry.x;
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
  const partial = state.partial;
  return {
    messages: state.messages,
    info: state.info,
    trajectory_format: state.format,
    // Omit the key entirely when idle so consumers can tell "no partial" from "empty partial".
    partial: partial.thinking || partial.text ? partial : undefined,
  };
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
    if (!data || typeof data !== "object") return null;
    // Same bound as the journal path: one tool result here was measured at 437 MB, and a
    // whole-export read is the one place the full object is materialised at once.
    const messages = (data as Trajectory).messages;
    if (Array.isArray(messages)) {
      return {
        ...(data as Trajectory),
        messages: messages.map((m) => (typeof m?.content === "string" ? { ...m, content: boundText(m.content) } : m)),
      };
    }
    return data as Trajectory;
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

/**
 * Poll a trajectory and call `onSnapshot` on every change. The snapshot is only valid during
 * the callback: afterwards the journal-backed messages are slimmed in place (see `slim.ts`).
 */
export function watchTrajectory(path: string, onSnapshot: (traj: Trajectory) => void, options: WatchOptions = {}): WatchHandle {
  const intervalMs = options.intervalMs ?? POLL_MS;
  const journal = journalPathFor(path);
  const state = newJournalState();
  let journalMode = false;
  let slimmed = 0;
  let lastStamp = "";
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    if (journalMode || existsSync(journal)) {
      journalMode = true;
      const before = state.messages;
      if (consumeJournal(state, journal)) {
        if (state.messages !== before) slimmed = 0; // journal truncated and replayed from scratch
        onSnapshot(journalTrajectory(state));
        // The consumer has read the full messages: keep only their slim form from now on
        // (a live run otherwise retains every API response and raw output twice over).
        for (let i = slimmed; i < state.messages.length; i++) state.messages[i] = slimMessage(state.messages[i]!);
        slimmed = state.messages.length;
      }
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
