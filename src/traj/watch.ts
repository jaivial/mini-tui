/**
 * Trajectory file access: one-shot reads plus a polling watcher.
 *
 * `DefaultAgent.save()` rewrites the whole JSON on every step (non-atomic `write_text`),
 * so the watcher tolerates mid-write reads: a parse failure keeps the last good snapshot
 * and is retried on the next tick.
 */

import { readFileSync, statSync } from "node:fs";

import type { Trajectory } from "./schema";
import { POLL_MS } from "../config";

export function readTrajectory(path: string): Trajectory | null {
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
  let lastStamp = "";
  let stopped = false;

  const tick = () => {
    if (stopped) return;
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
