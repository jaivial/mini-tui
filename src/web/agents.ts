/**
 * The agents of a session, for the web: the whole tree of agent sessions it started (children,
 * their own subagents, recursively), each one's state and measured cache reuse, and the messages
 * between them (`subagents/events.jsonl`, written by each hub: delegations, handoffs, peer
 * messages and replies, fan-outs, warmups, turn ends).
 *
 * Every agent is a session of its own, saved under `<run dir>/subagents/<name>/`; its own
 * subagents live under `<that dir>/subagents/`, so the tree is the folder tree.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { readSubagentIndex, subagentSessionId } from "../mini/subagents";
import { listAgentDefs, type AgentDef } from "../mini/agentDefs";

export interface AgentCache {
  inherited_messages: number;
  first_prompt: number;
  first_cached: number;
  prompt_total: number;
  cached_total: number;
  warm: string;
}

export interface AgentNode {
  name: string;
  /** The path of names from the root's child down to this one (`translator`, `login/backend`). */
  path: string;
  sessionId: string;
  agent: string;
  origin: string;
  from: string;
  state: string;
  exitStatus: string;
  model: string;
  task: string;
  steps: number;
  cost: number;
  lastCommand: string;
  awaiting: string;
  waitingChildren: string[];
  startedAt: number;
  lastActivity: number;
  cache?: AgentCache;
  children: AgentNode[];
}

export interface AgentEvent {
  at: number;
  kind: string;
  from: string;
  to: string;
  text: string;
  /** The hub that logged it: "" for the session's own, else the agent path whose hub it is. */
  scope: string;
  model?: string;
  agent?: string;
  inherited?: number;
  status?: string;
  chain?: string[];
  seconds?: number;
}

export interface AgentsView {
  sessionId: string;
  nodes: AgentNode[];
  events: AgentEvent[];
  defs: AgentDef[];
}

const MAX_DEPTH = 6;
const MAX_EVENTS = 400;

/** Parsed events per file, keyed by its size: an unchanged log costs one `stat`. */
const eventCache = new Map<string, { size: number; events: AgentEvent[] }>();

function readEvents(file: string, scope: string): AgentEvent[] {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return [];
  }
  const hit = eventCache.get(file);
  if (hit && hit.size === size) return hit.events;
  const events: AgentEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      events.push({ ...e, scope, usage: undefined });
    } catch {
      // a line being written: the next read gets it
    }
  }
  eventCache.set(file, { size, events });
  return events;
}

function walk(trajPath: string, parentId: string, prefix: string, depth: number, events: AgentEvent[]): AgentNode[] {
  const subDir = join(dirname(trajPath), "subagents");
  if (!existsSync(subDir)) return [];
  events.push(...readEvents(join(subDir, "events.jsonl"), prefix));
  const entries = readSubagentIndex(trajPath) as unknown as Array<Record<string, unknown>>;
  return entries.map((e) => {
    const name = String(e.name ?? "");
    const path = prefix ? `${prefix}/${name}` : name;
    const sessionId = subagentSessionId(parentId, name);
    const traj = String(e.traj_path ?? "");
    return {
      name,
      path,
      sessionId,
      agent: String(e.agent ?? ""),
      origin: String(e.origin ?? ""),
      from: String(e.from ?? ""),
      state: String(e.state ?? ""),
      exitStatus: String(e.exit_status ?? ""),
      model: String(e.model ?? ""),
      task: String(e.brief || e.task || ""),
      steps: Number(e.steps ?? 0),
      cost: Number(e.cost ?? 0),
      lastCommand: String(e.last_command ?? ""),
      awaiting: String(e.awaiting ?? ""),
      waitingChildren: Array.isArray(e.waiting_children) ? (e.waiting_children as string[]) : [],
      startedAt: Number(e.started_at ?? 0),
      lastActivity: Number(e.last_activity ?? 0),
      cache: e.cache as AgentCache | undefined,
      children: depth < MAX_DEPTH && traj ? walk(traj, sessionId, path, depth + 1, events) : [],
    };
  });
}

export function agentsView(sessionId: string, trajPaths: string[]): AgentsView {
  const events: AgentEvent[] = [];
  // Oldest run first, so the tree reads in the order the agents were started.
  const nodes = [...trajPaths].reverse().flatMap((p) => walk(p, sessionId, "", 0, events));
  events.sort((a, b) => a.at - b.at);
  return { sessionId, nodes, events: events.slice(-MAX_EVENTS), defs: listAgentDefs() };
}
