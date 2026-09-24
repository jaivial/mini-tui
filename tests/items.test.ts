import { describe, expect, test } from "bun:test";

import { buildItems, buildItemsIncremental, type ItemBuildCache } from "../src/ui/items";
import type { RunEvent } from "../src/traj/schema";

const call = (id: string): RunEvent => ({ type: "tool_call", id, name: "bash", command: "echo hi" });
const observation = (id: string): RunEvent => ({ type: "observation", toolCallId: id, returncode: 0, output: "ok", exceptionInfo: "" });

describe("append-aware transcript item index", () => {
  test("matches the full builder for append-only tool/observation updates", () => {
    let events: RunEvent[] = [{ type: "task", text: "task" }, call("a")];
    let cache: ItemBuildCache | undefined = buildItemsIncremental(events);
    events = [...events, observation("a"), call("b")];
    cache = buildItemsIncremental(events, cache, true);
    events = [...events, observation("b")];
    cache = buildItemsIncremental(events, cache, true);
    expect(cache.items).toEqual(buildItems(events));
  });

  test("falls back for an observation that arrives before its tool call", () => {
    let events: RunEvent[] = [observation("late")];
    let cache = buildItemsIncremental(events);
    events = [...events, call("late")];
    cache = buildItemsIncremental(events, cache, true);
    expect(cache.items).toEqual(buildItems(events));
  });

  test("rebuilds when the caller does not establish append-only semantics", () => {
    const first = [call("a")];
    const cache = buildItemsIncremental(first);
    const replacement = [call("b")];
    expect(buildItemsIncremental(replacement, cache, false).items).toEqual(buildItems(replacement));
  });
  test("matches the full builder across randomized append/replacement sequences", () => {
    const makeEvent = (random: number): RunEvent => {
      const kind = random % 8;
      if (kind < 3) return call(`id${random % 4}`);
      if (kind < 6) return observation(`id${(random + 1) % 4}`);
      if (kind === 6) return { type: "assistant", text: "reply" };
      return { type: "task", text: "task" };
    };
    for (let seed = 0; seed < 25; seed++) {
      let events: RunEvent[] = [];
      let cache: ItemBuildCache | undefined;
      let state = seed;
      const random = () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state % 11;
      };
      for (let step = 0; step < 45; step++) {
        const append = random() !== 0;
        if (!append && events.length > 0) {
          events = events.slice(0, random() % events.length);
          cache = undefined;
        }
        events = [...events, makeEvent(random())];
        cache = buildItemsIncremental(events, cache, append);
        expect(cache.items).toEqual(buildItems(events));
      }
    }
  });

});
