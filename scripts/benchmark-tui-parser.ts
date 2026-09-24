#!/usr/bin/env bun
/**
 * Reproduce the TUI's long-run trajectory ingestion cost without a terminal.
 * Each iteration appends two realistic messages, parses only the new slice,
 * and extends the tool/observation item index incrementally.
 *
 *   bun scripts/benchmark-tui-parser.ts [steps]
 */

import { performance } from "node:perf_hooks";
import { buildItems, buildItemsIncremental, type ItemBuildCache } from "../src/ui/items";
import { createParseState, messagesToEvents } from "../src/traj/parse";
import type { RunEvent, TrajectoryMessage } from "../src/traj/schema";

const steps = Number(process.argv[2] ?? 5000);
if (!Number.isSafeInteger(steps) || steps < 1) {
  console.error("usage: bun scripts/benchmark-tui-parser.ts [positive steps]");
  process.exit(2);
}

const messages: TrajectoryMessage[] = [
  { role: "system", content: "system" },
  { role: "user", content: "Please solve this issue: benchmark" },
];
const state = createParseState();
let consumed = 0;
let eventCount = 0;
const events: RunEvent[] = [];
let itemCache: ItemBuildCache | undefined;
let itemCount = 0;
const started = performance.now();

for (let i = 0; i < steps; i++) {
  messages.push({ role: "assistant", content: `reply ${i}` });
  messages.push({
    role: "tool",
    content: JSON.stringify({ returncode: 0, output: `output ${i}` }),
    tool_call_id: `call_${i}`,
    extra: { returncode: 0 },
  });
  const parsed = messagesToEvents(messages, {}, consumed, state);
  eventCount += parsed.length;
  for (const event of parsed) events.push(event);
  itemCache = buildItemsIncremental(events, itemCache, true);
  itemCount = itemCache.items.length;
  consumed = messages.length;
}

const elapsed = performance.now() - started;
console.log(`steps=${steps} messages=${messages.length} events=${eventCount} items=${itemCount} elapsed_ms=${elapsed.toFixed(1)}`);
