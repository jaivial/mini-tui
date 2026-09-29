/**
 * A stand-in for the `mini` agent, so resume can be tested end to end without a model or a network.
 *
 * `makeFakeAgent(dir)` writes an executable script and returns its path plus a reader for what it was
 * asked to do. The script records its argv, then behaves like the real agent's journal: it writes
 * `<traj>.jsonl` with the messages of any `--resume` file, the new task as a `UserNewTask` message and a
 * canned reply, then exits. Point `MINITUI_MINI_BIN` at it (with `MINITUI_EMBEDDED_AGENT=0`).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentCall {
  argv: string[];
  task: string;
  resume?: string;
  model?: string;
  /** The messages the agent was resumed with (empty for a fresh run). */
  resumedMessages: unknown[];
  cwd: string;
}

export function makeFakeAgent(dir: string, options: { holdMs?: number } = {}) {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "agent-calls.jsonl");
  const script = join(dir, "fake-mini");
  writeFileSync(
    script,
    `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const out = at("-o"), resume = at("--resume"), task = at("-t") ?? "", model = at("-m");
let resumed = [];
try { if (resume) resumed = JSON.parse(readFileSync(resume, "utf8")).messages ?? []; } catch {}
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, task, resume, model, resumedMessages: resumed, cwd: process.cwd() }) + "\\n");
const line = (o) => JSON.stringify(o) + "\\n";
const journal = out.replace(/\\.json$/, ".jsonl");
const messages = resume
  ? [...resumed, { role: "user", content: "The user added a new task: " + task, extra: { interrupt_type: "UserNewTask" } }]
  : [{ role: "system", content: "system" }, { role: "user", content: task }];
messages.push({ role: "assistant", content: "fake reply to: " + task.slice(0, 40), extra: { cost: 0.001 } });
writeFileSync(journal, line({ t: "meta", trajectory_format: "mini-swe-agent-1.1" }) + messages.map((m) => line({ t: "msg", m })).join("") +
  line({ t: "info", i: { model_stats: { instance_cost: 0.01, api_calls: messages.length }, exit_status: "Submitted", submission: "ok" } }));
await Bun.sleep(${options.holdMs ?? 0});
`,
  );
  chmodSync(script, 0o755);
  return {
    script,
    calls(): AgentCall[] {
      return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
  };
}
