/**
 * The agents view, built only when its INPUTS moved. The deployed server rebuilt the whole tree —
 * walk the run dirs, re-read the roster, re-read every agent def, re-serialize 34 kB — on every
 * tick of every open `/agents/stream`, and again per stream (each had its own `setInterval`),
 * whether or not anything had changed; the answer was then thrown away unless it differed from
 * that stream's own last. A view is a function of a known set of files, so the cheap question is
 * not "what changed?" but "did anything the build read move?" — one `stat` per file, from the
 * stamps the build itself took as it read (`agents.ts`).
 *
 * Correctness rule (the reason the stamps are taken at read time, `mtimeNs`-precise): a HIT means
 * every input is byte-identical to what the build read, so the answer cannot be stale. A write
 * that lands anywhere — before, during or after a build — flips a stamp and buys a rebuild. The
 * alternative (stamp after the build) can pin the OLD bytes to the NEW stamp and freeze them for
 * as long as the file stays quiet.
 */
import { agentsViewWithInputs, inputIdentity, type AgentsView, type InputStamps } from "./agents";

export interface AgentsViewEntry {
  view: AgentsView;
  /** The full payload as the stream sends it, serialized once per build (not once per push). */
  fullJson: string;
  /** True when this call actually rebuilt (a test or a probe can count rebuilds honestly). */
  rebuilt: boolean;
}

export class AgentsViewCache {
  readonly #map = new Map<string, { inputs: InputStamps; view: AgentsView; fullJson: string }>();
  /** Honest counters, so a test can see rebuilds instead of guessing from CPU. */
  readonly stats = { builds: 0, hits: 0 };

  get(sessionId: string, trajPaths: string[]): AgentsViewEntry {
    const key = `${sessionId}\u0000${trajPaths.join("\u0000")}`;
    const prev = this.#map.get(key);
    // A run dir added to the session is part of the key; a subtree that appears is caught by its
    // parent's roster file; a def that appears is caught by the defs dir. All three are stamped.
    if (prev && sameInputs(prev.inputs)) {
      this.stats.hits++;
      return { view: prev.view, fullJson: prev.fullJson, rebuilt: false };
    }
    const built = agentsViewWithInputs(sessionId, trajPaths);
    const fullJson = JSON.stringify(built.view);
    if (this.#map.size >= 256) this.#map.delete(this.#map.keys().next().value as string);
    this.#map.set(key, { inputs: built.inputs, view: built.view, fullJson });
    this.stats.builds++;
    return { view: built.view, fullJson, rebuilt: true };
  }
}

/** Is every input still exactly what the build read (content, not timestamps)? */
function sameInputs(inputs: InputStamps): boolean {
  for (const [key, seen] of inputs.stamps) {
    if (inputIdentity(key) !== seen) return false;
  }
  return true;
}
