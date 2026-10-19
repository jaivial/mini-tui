/**
 * The ONE place a queue subcommand is spawned and read — an adapter over the generic launcher.
 *
 * The machinery used to live here: E46 and E47 were the same fix applied twice (two launchers, each with
 * its own copy of "deadline + TERM→KILL + bounded read + cancelled readers") and by E48 the copies had
 * already diverged in ways that were defects, measured against the deployed code (`e2890ec`):
 *
 * 1. **The web reader mixed the two streams into one buffer.** `runQueueRead` shared one `chunks` array
 *    between its stdout and its stderr collect, so a child that printed a warning line before its JSON
 *    made `/task-graph` answer `bad-json` with the warning glued to the payload.
 * 2. **The web reader's cap did not cover stderr.** 200 MB of stderr after the JSON tripped no bound:
 *    **1 040 MiB RSS in the parent**, from a reader whose whole point is a 4 MB cap.
 *
 * Those bounds are not queue business, and the last copy that did without them — the remote folder
 * listing in `web/folders.ts` — was measured at 628 MiB of RSS and a deadline that never landed (E49).
 * So the machinery moved to `proc/spawnBounded.ts`, where nothing about it assumes a queue subcommand,
 * and this file keeps the queue's names, its default budget and its callers.
 *
 * A third launcher cannot copy a broken half any more: `tests/queue-spawn.test.ts` reads the source and
 * refuses `Bun.spawn` outside an explicit allowlist (the lesson of E41 — protection by the type system
 * where possible, by a source-reading test where not).
 */
import {
  KILL_GRACE_MS,
  spawnBounded,
  type BoundedSpawnOptions,
  type BoundedSpawnResult,
} from "../proc/spawnBounded";

export { KILL_GRACE_MS };

/** 4 MiB TOTAL across stdout and stderr: 10 000 tasks with the trajectories they carry. */
export const QUEUE_SPAWN_MAX_BYTES = 4 * 1024 * 1024;

export interface QueueSpawnOptions extends BoundedSpawnOptions {}
export interface QueueSpawnResult extends BoundedSpawnResult {}

export function spawnQueue(argv: string[], opts: QueueSpawnOptions = {}): Promise<QueueSpawnResult> {
  return spawnBounded(argv, { ...opts, maxBytes: opts.maxBytes ?? QUEUE_SPAWN_MAX_BYTES });
}
