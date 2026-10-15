/**
 * Seed one synthetic, deliberately DENSE session into a scratch sessions DB so the
 * web panel can be measured against a transcript that looks like a real long run:
 * 520 messages, 140 tool cards, mixed markdown/code/thinking/notice rows.
 *
 * This is a measurement fixture, not production code: it writes only to the DB path
 * given by MINITUI_DB_PATH (the perf servers get their own scratch DB), so it can
 * never touch the real ~/.config/mini-tui/sessions.db.
 *
 * Usage: MINITUI_DB_PATH=/tmp/r2/sessions.db bun run scripts/seed-perf-session.ts [id]
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TrajectoryMessage } from "../src/traj/schema";
import { openDb } from "../src/sessions";
import { createParseState, messagesToEvents } from "../src/traj/parse";

const DB = process.env.MINITUI_DB_PATH ?? "";
if (!DB.includes("r2") && !DB.includes("perf")) {
  console.error(`refusing to seed ${DB || "(unset)"}: set MINITUI_DB_PATH to a scratch path`);
  process.exit(1);
}
const id = process.argv[2] ?? "perf-dense-01";

const LOREM = [
  "The parser hands the transcript a row per model call, so a long run paints hundreds of bubbles.",
  "Scrolling is where a dense transcript hurts: every off-screen row still costs style and layout.",
  "```ts\nconst rows = events.map((e) => ({ kind: e.type, event: e }));\nconsole.log(rows.length);\n```",
  "Tool output is the tall row — a full file listing is dozens of lines inside one step card.",
  "| column | value |\n| --- | --- |\n| rows | 520 |\n| cards | 140 |",
  "![shot](/api/attachments/0123456789abcdef)",
];

const messages: TrajectoryMessage[] = [];
const push = (m: TrajectoryMessage) => messages.push(m);

push({ role: "user", content: "Perf fixture: a long session to measure transcript scroll and paint." });

let n = 0;
while (messages.length < 520) {
  n += 1;
  // A user turn every ~3 tool calls, so the bubble mix is realistic.
  push({ role: "user", content: LOREM[n % LOREM.length]!, extra: { interrupt_type: "UserNewTask" } });

  // Assistant answer with markdown + code + table + image (exercises the lazy-image path).
  push({
    role: "assistant",
    content: `${LOREM[(n + 1) % LOREM.length]!}\n\n${LOREM[(n + 3) % LOREM.length]!}\n\n- step one\n- step two\n- step three`,
  });

  // 2-3 tool cards per turn, each with a tool_call + its observation (one merged row).
  const cards = 2 + (n % 2);
  for (let c = 0; c < cards; c += 1) {
    const callId = `call-${n}-${c}`;
    push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: callId, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `sed -n '${c * 40 + 1},${c * 40 + 40}p' src/web/serve.ts` }) } }],
    });
    // A realistically long observation — this is what makes step cards tall.
    const body = Array.from({ length: 24 }, (_, l) => `${String(l + 1).padStart(4, " ")}  const value${l} = compute(${c + 1}, ${l});`).join("\n");
    push({ role: "tool", tool_call_id: callId, content: `${body}\nexit status 0` });
  }

  if (n % 5 === 0) {
    push({ role: "assistant", content: "", reasoning_content: "Checking the diff, then the tests. The tail of a long reasoning block that would otherwise render inline." } as TrajectoryMessage);
  }
  if (n % 11 === 0) push({ role: "user", content: "compact the context", extra: { interrupt_type: "Compaction", compaction: { tokens_before: 180000, tokens_after: 42000 } } });
}

mkdirSync(dirname(DB), { recursive: true });
const db = openDb(DB);
const now = Date.now();
// The web restore path (restoreFromRow) reads events_json, not the trajectory: derive
// the events here exactly as a live run would, or the panel opens an empty transcript.
const events = messagesToEvents(messages, { showSystem: false }, 0, createParseState(messages));
db.query(
  `INSERT OR REPLACE INTO sessions (id, title, cwd, model, task, created_at, updated_at, api_calls, cost, exit_status, events_json, info_json, messages_json)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
).run(
  id,
  "Perf fixture — dense session",
  process.cwd(),
  "claude-sonnet-5",
  "measure the dense transcript",
  now - 86_400_000,
  now,
  n,
  0.42,
  "",
  JSON.stringify(events),
  JSON.stringify(messages),
);
db.close();

console.log(
  `seeded ${id}: ${messages.length} messages, ${events.length} events (${n} assistant turns) into ${DB}`,
);