import type { RunEvent } from "../traj/schema";

export interface Pair {
  toolIndex: number;
  observationIndex: number | null;
}

export type Item =
  | { kind: "event"; index: number }
  | { kind: "pair"; toolIndex: number; observationIndex: number | null };

/** Group each tool call with its observation (FIFO, `tool_call_id` preferred). */

export function buildItems(events: RunEvent[]): Item[] {
  const pairs: Pair[] = [];
  const freePairs: Pair[] = [];
  const byId = new Map<string, Pair[]>();

  events.forEach((event, index) => {
    if (event.type !== "tool_call") return;
    const pair: Pair = { toolIndex: index, observationIndex: null };
    pairs.push(pair);
    if (event.id) {
      const queue = byId.get(event.id);
      if (queue) queue.push(pair);
      else byId.set(event.id, [pair]);
    } else freePairs.push(pair);
  });

  events.forEach((event, index) => {
    if (event.type !== "observation") return;
    const queue = (event.toolCallId && byId.get(event.toolCallId)) || [];
    const pair = queue.shift() ?? freePairs.shift();
    if (queue.length === 0 && event.toolCallId) byId.delete(event.toolCallId);
    if (pair) pair.observationIndex = index;
  });

  const claimed = new Set(pairs.map((p) => p.observationIndex).filter((i): i is number => i !== null));
  const pairAt = new Map(pairs.map((p) => [p.toolIndex, p] as const));
  const items: Item[] = [];
  events.forEach((event, index) => {
    if (event.type === "tool_call") {
      const pair = pairAt.get(index);
      if (pair) items.push({ kind: "pair", toolIndex: pair.toolIndex, observationIndex: pair.observationIndex });
      return;
    }
    if (event.type === "observation" && claimed.has(index)) return;
    items.push({ kind: "event", index });
  });
  return items;
}

/** Mutable append-only cache for the transcript pairing index. */
export interface ItemBuildCache {
  events: RunEvent[];
  items: Item[];
  eventCount: number;
  byId: Map<string, Array<Pair & { itemIndex: number }>>;
  freePairs: Array<Pair & { itemIndex: number }>;
  pendingObservations: number[];
}

function itemCacheFromItems(events: RunEvent[], items: Item[]): ItemBuildCache {
  const itemIndexByTool = new Map<number, number>();
  items.forEach((item, itemIndex) => {
    if (item.kind === "pair") itemIndexByTool.set(item.toolIndex, itemIndex);
  });
  const byId = new Map<string, Array<Pair & { itemIndex: number }>>();
  const freePairs: Array<Pair & { itemIndex: number }> = [];
  events.forEach((event, index) => {
    if (event.type !== "tool_call") return;
    const itemIndex = itemIndexByTool.get(index);
    // buildItems always emits a pair for every tool call. Keep a safe fallback
    // for a malformed/custom builder result rather than corrupting the cache.
    const builtItem = itemIndex === undefined ? undefined : items[itemIndex];
    const observationIndex = builtItem?.kind === "pair" ? builtItem.observationIndex : null;
    const pair = { toolIndex: index, observationIndex, itemIndex: itemIndex ?? -1 };
    if (pair.observationIndex !== null) return;
    if (event.id) {
      const queue = byId.get(event.id);
      if (queue) queue.push(pair);
      else byId.set(event.id, [pair]);
    } else {
      freePairs.push(pair);
    }
  });
  const claimed = new Set<number>();
  items.forEach((item) => {
    if (item.kind === "pair" && item.observationIndex !== null) claimed.add(item.observationIndex);
  });
  const pendingObservations: number[] = [];
  events.forEach((event, index) => {
    if (event.type === "observation" && !claimed.has(index)) pendingObservations.push(index);
  });
  return { events, items, eventCount: events.length, byId, freePairs, pendingObservations };
}
/**
 * Build the item index, extending a previous cache only when the caller has
 * established that the new event array is an append-only update. All other
 * callers use the compatibility rebuild path.
 */
export function buildItemsIncremental(
  events: RunEvent[],
  previous?: ItemBuildCache,
  appendOnly = false,
): ItemBuildCache {
  if (!previous || !appendOnly || events.length < previous.eventCount) return itemCacheFromItems(events, buildItems(events));
  for (let index = previous.eventCount; index < events.length; index++) {
    const event = events[index]!;
    if (event.type === "tool_call") {
      // A tool arriving after an unmatched observation needs the full
      // retroactive pairing pass. This is uncommon and correctness wins.
      if (previous.pendingObservations.length > 0) return itemCacheFromItems(events, buildItems(events));
      const itemIndex = previous.items.length;
      const pair = { toolIndex: index, observationIndex: null, itemIndex };
      previous.items.push({ kind: "pair", toolIndex: index, observationIndex: null });
      if (event.id) {
        const queue = previous.byId.get(event.id);
        if (queue) queue.push(pair);
        else previous.byId.set(event.id, [pair]);
      } else {
        previous.freePairs.push(pair);
      }
    } else if (event.type === "observation") {
      const queue = event.toolCallId ? previous.byId.get(event.toolCallId) : undefined;
      const pair = queue?.shift() ?? previous.freePairs.shift();
      if (queue && queue.length === 0) previous.byId.delete(event.toolCallId!);
      if (pair) {
        pair.observationIndex = index;
        previous.items[pair.itemIndex] = { kind: "pair", toolIndex: pair.toolIndex, observationIndex: index };
      } else {
        previous.pendingObservations.push(index);
        previous.items.push({ kind: "event", index });
      }
    } else {
      previous.items.push({ kind: "event", index });
    }
  }
  previous.events = events;
  previous.eventCount = events.length;
  return previous;
}

