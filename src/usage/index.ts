/**
 * v6-B: the process-wide usage recorder.
 *
 * One lazily-opened `UsageStore` per process, fed from the run paths that already
 * watch a journal. Recording is best-effort by design and can never break a run:
 * a failed insert is swallowed (the run's output matters more than the metric), and
 * the store is opened lazily so a host with no runs never creates the file.
 */
import type { TrajectoryMessage } from "../traj/schema";

import { usageFromMessages, type UsageContext } from "./record";
import { UsageStore, usageDbPath, type UsageCall, type UsageSummary, type UsageWindow } from "./store";

let store: UsageStore | undefined;

/**
 * Whether this process is a test run. The e2e suites spawn `bun src/index.ts` as
 * real subprocesses with a curated env, so a preload guard is not enough on its
 * own: the fixture agent's zero-token calls would land straight in the real
 * `~/.local/share/mini-tui/usage.sqlite`, polluting the operator's spend.
 *
 * `NODE_ENV=test` is the marker: `bun test` exports it and a spawned child
 * inherits it, so it holds for in-process and subprocess runs alike.
 * `MINITUI_USAGE_DB` still wins when set, so a test that *wants* a ledger of its
 * own gets one.
 */
function underTest(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "test" || env.MINITUI_TEST === "1";
}

export function usageStore(env: NodeJS.ProcessEnv = process.env): UsageStore {
  if (!store) {
    if (underTest(env) && !env.MINITUI_USAGE_DB) {
      // A test run with no store of its own records nothing rather than into the
      // real one. `recordUsage` treats a missing store as "nothing to record".
      throw new Error("usage recording disabled under test");
    }
    store = new UsageStore(usageDbPath(env));
  }
  return store;
}

/** Close and forget the store (tests, and a clean shutdown). */
export function resetUsageStore(): void {
  store?.close();
  store = undefined;
}

/**
 * Record the calls in a run's messages from `from` onwards. Returns how many rows
 * were new, so a caller can log it without re-reading the store.
 */
export function recordUsage(
  messages: readonly TrajectoryMessage[],
  context: UsageContext,
  from = 0,
): number {
  try {
    const target = usageStore();
    let written = 0;
    for (const call of usageFromMessages(messages, context, from)) {
      if (target.record(call)) written++;
    }
    return written;
  } catch {
    // A metric must never take a run down with it.
    return 0;
  }
}

export function recordCalls(calls: readonly UsageCall[]): number {
  try {
    const target = usageStore();
    let written = 0;
    for (const call of calls) if (target.record(call)) written++;
    return written;
  } catch {
    return 0;
  }
}

export function usageSummary(window: UsageWindow = {}): UsageSummary {
  try {
    return usageStore().summarize(window);
  } catch {
    // No store yet (nothing has run): an empty window is the honest answer.
    return usageStoreEmpty(window);
  }
}

export function usageRecent(window: UsageWindow = {}, limit = 200): UsageCall[] {
  try {
    return usageStore().recent(window, limit);
  } catch {
    return [];
  }
}

function usageStoreEmpty(window: UsageWindow): UsageSummary {
  const empty = {
    key: "total",
    label: "",
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    unknownCostCalls: 0,
    errors: 0,
    avgLatencyMs: null,
    lastUsedAt: null,
  };
  return {
    since: window.since ?? null,
    until: window.until ?? null,
    totals: empty,
    byProvider: [],
    byModel: [],
    providers: [],
    costComplete: true,
  };
}