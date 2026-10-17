/**
 * A stand-in for the task-graph queue binary, so the chat ↔ queue bridge can be
 * exercised end to end without the Rust binary or embeddings.
 *
 * `makeFakeQueue(dir, scenario)` writes an executable script plus a scenario
 * file and returns helpers to read what the bridge asked the queue to do and to
 * rewrite the scenario mid-test. The script keeps the whole task graph as one
 * JSON document at the `--db` path the bridge passes, emits the events the real
 * queue would (put → pending; amend on running → fenced interrupt + goal_updated;
 * retry → pending), and records every invocation as JSONL.
 *
 * Scenario knobs:
 *   failPut               → `put` exits 1 (creation sweep must retry)
 *   putSleepMs            → `put` is slow (concurrent sweeps must not double-put)
 *   retryRequiresReconciled → `retry` without `--reconciled` exits 1 (default, like the real queue)
 *   amendError            → `amend` exits 1 with this message (stale version, closed task)
 *   searchResults         → the fixed vector-similarity ranking `search` returns
 *   seedTasks             → tasks present before the first call (with pre-existing events)
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeTaskSeed {
  id: string;
  project?: string;
  cwd?: string;
  goal?: string;
  status?: string;
  owner?: string | null;
  fence?: number;
  lease_until?: number | null;
  result?: string | null;
  goal_version?: number;
  /** Events that already happened (seqs must be unique across all seeds). */
  events?: Array<{ seq: number; kind: string; status?: string }>;
}

export interface QueueScenario {
  failPut?: boolean;
  putSleepMs?: number;
  retryRequiresReconciled?: boolean;
  amendError?: string;
  searchResults?: Array<{ id: string; similarity: number }>;
  seedTasks?: FakeTaskSeed[];
}

export function makeFakeQueue(dir: string, scenario: QueueScenario = {}) {
  const scenarioPath = join(dir, "queue-scenario.json");
  const callsPath = join(dir, "queue-calls.jsonl");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const script = join(dir, "fake-queue");
  writeFileSync(
    script,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const has = (f) => argv.includes(f);
const scenario = JSON.parse(readFileSync(${JSON.stringify(scenarioPath)}, "utf8"));
const db = at("--db");
const err = (m) => { process.stderr.write(m + "\\n"); process.exit(1); };
let state = { tasks: {}, seq: 0 };
if (db && existsSync(db)) state = JSON.parse(readFileSync(db, "utf8"));
else if (db && scenario.seedTasks) {
  for (const t of scenario.seedTasks) {
    state.tasks[t.id] = { project: t.project ?? "p", cwd: t.cwd ?? "/tmp", goal: t.goal ?? "", status: t.status ?? "pending",
      owner: t.owner ?? null, fence: t.fence ?? 0, lease_until: t.lease_until ?? null, result: t.result ?? null, goal_version: t.goal_version ?? 1 };
    for (const e of t.events ?? []) state.seq = Math.max(state.seq, e.seq);
  }
}
const eventsOf = (t) => (t.events ??= []);
const ev = (t, e) => eventsOf(t).push({ seq: ++state.seq, task: t.id ?? at("--id"), goal_version: t.goal_version, fence: t.fence, status: null, created: Math.floor(Date.now() / 1000), ...e });
const action = argv[1];
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(argv.slice(1)) + "\\n");
if (action === "put") {
  if (scenario.putSleepMs) await Bun.sleep(scenario.putSleepMs);
  if (scenario.failPut) err("simulated put failure");
  const id = at("--id");
  if (!state.tasks[id]) {
    const t = (state.tasks[id] = { id, project: at("--project") ?? "", cwd: at("--cwd") ?? "", goal: readFileSync(at("--goal-file"), "utf8"),
      status: "pending", owner: null, fence: 0, lease_until: null, result: null, goal_version: 1 });
    ev(t, { kind: "state_changed", status: "pending" });
  }
  process.stdout.write("put " + id + "\\n");
} else if (action === "graph-read") {
  const nodes = Object.values(state.tasks).map((t) => ({ ...t }));
  const edges = Object.values(state.tasks).flatMap((t) => (t.edges ?? []).map((dependency) => ({ task: t.id, dependency })));
  process.stdout.write(JSON.stringify({ nodes, edges }) + "\\n");
} else if (action === "events-read") {
  const after = Number(at("--after") ?? 0), limit = Number(at("--limit") ?? 100);
  const all = Object.values(state.tasks).flatMap((t) => eventsOf(t)).sort((a, b) => a.seq - b.seq);
  process.stdout.write(JSON.stringify({ events: all.filter((e) => e.seq > after).slice(0, limit) }) + "\\n");
} else if (action === "amend") {
  const id = at("--id"), t = state.tasks[id];
  if (!t) err("no such task " + id);
  if (scenario.amendError) err(scenario.amendError);
  if (Number(at("--goal-version")) !== t.goal_version) err("goal version stale for " + id);
  const note = readFileSync(at("--goal-file"), "utf8");
  let wasRunning = false;
  if (t.status === "running") { wasRunning = true; t.status = "interrupted"; t.fence += 1; ev(t, { kind: "state_changed", status: "interrupted" }); }
  t.goal = t.goal ? t.goal + "\\n" + note : note;
  t.goal_version += 1;
  ev(t, { kind: "goal_updated" });
  process.stdout.write("amend " + id + " v" + t.goal_version + (wasRunning ? " fenced" : "") + "\\n");
} else if (action === "retry") {
  const id = at("--id"), t = state.tasks[id];
  if (!t) err("no such task " + id);
  if (scenario.retryRequiresReconciled !== false && !has("--reconciled")) err("retry of an interrupted task requires --reconciled yes");
  if (t.status !== "interrupted") err("task " + id + " is not interrupted: " + t.status);
  t.status = "pending"; t.owner = null; t.fence += 1;
  ev(t, { kind: "state_changed", status: "pending" });
  process.stdout.write("retry " + id + "\\n");
} else if (action === "search") {
  process.stdout.write(JSON.stringify({ results: scenario.searchResults ?? [] }) + "\\n");
} else err("unsupported action " + action);
if (db) writeFileSync(db, JSON.stringify(state));
`,
  );
  chmodSync(script, 0o755);
  return {
    script,
    calls(): string[][] {
      return existsSync(callsPath) ? readFileSync(callsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
  };
}

/** Rewrite the scenario between queue calls (the script re-reads it every invocation). */
export function setScenario(dir: string, scenario: QueueScenario): void {
  writeFileSync(join(dir, "queue-scenario.json"), JSON.stringify(scenario));
}

export interface FakeGraphState {
  tasks: Record<string, { id?: string; project: string; cwd: string; goal: string; status: string; owner: string | null; fence: number; lease_until: number | null; result: string | null; goal_version: number; /** Task ids this one waits on (the graph `edges` list). */
    edges?: string[];
    events: Array<{ seq: number; task?: string; kind: string; status?: string | null; goal_version?: number; fence?: number }> }>;
  seq: number;
}

export function readQueueState(graphDb: string): FakeGraphState {
  return JSON.parse(readFileSync(graphDb, "utf8")) as FakeGraphState;
}

/** Mutate the fake queue's graph directly (seed events for the event consumer). */
export function writeQueueState(graphDb: string, mutate: (state: FakeGraphState) => void): void {
  const state = existsSync(graphDb) ? JSON.parse(readFileSync(graphDb, "utf8")) : { tasks: {}, seq: 0 };
  mutate(state as FakeGraphState);
  writeFileSync(graphDb, JSON.stringify(state));
}
