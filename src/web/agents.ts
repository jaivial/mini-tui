/**
 * The agents of a session, for the web: the whole tree of agent sessions it started (children,
 * their own subagents, recursively), each one's state and measured cache reuse, and the messages
 * between them (`subagents/events.jsonl`, written by each hub: delegations, handoffs, peer
 * messages and replies, fan-outs, warmups, turn ends).
 *
 * Every agent is a session of its own, saved under `<run dir>/subagents/<name>/`; its own
 * subagents live under `<that dir>/subagents/`, so the tree is the folder tree.
 *
 * A build reports the FILES it read, stamped as it read them (`agentsCache` asks "did anything I
 * read move?" instead of rebuilding blind every tick — measured, E55). The stamp is taken just
 * BEFORE each read: if a write lands between the stamp and the read, the build sees the newer
 * bytes but keeps the older stamp, and the next check mismatches — an extra rebuild, never a stale
 * answer. The parse caches below are cleared at the start of every build for the same reason: a
 * rebuild is a fresh read, and a cache keyed coarser than this fingerprint could hand it the parse
 * from before the file moved.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { invalidateSubagentIndex, readSubagentIndex, subagentSessionId, subagentIndexPath } from "../mini/subagents";
import { agentDefsInputs, agentsDir, listAgentDefs, type AgentDef } from "../mini/agentDefs";

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

/**
 * One input's identity. The key says HOW ("bytes:…", "log:…", "list:…"), so a checker can re-derive
 * exactly what the build recorded:
 *
 *   - `bytes:<file>` — the file's CONTENT. File timestamps on this kernel are coarse: two writes
 *     in the same millisecond share `mtimeNs` AND `ctimeNs` (measured 2026-10-19: two rewrites 0 ms
 *     apart, identical `%y.%N`; the roster's own parse cache lives with the same bound via an
 *     explicit 1 s re-read window). A stamp can therefore miss a SAME-SIZE rewrite — and
 *     `"state": "running"` -> `"state": "waiting"` is one, the exact change this view must show.
 *   - `log:<file>` — the append-only `events.jsonl`: size + stamps. Its reader already trusts size
 *     alone (every append grows it); the stamps add insurance against a truncation.
 *   - `list:<dir>` — a listing of names: a def file that appears or goes away.
 *
 * A HIT is then byte-identical inputs — never a stale answer. The cost is reading the small files
 * (rosters and defs) once per tick: measured against the deployed rebuild (walk + 15 def parses +
 * a 34 kB stringify every 2 s per stream) it is a fraction, and it is what makes "nothing changed"
 * cheap enough to ask every time.
 */
export function inputIdentity(key: string): string {
  const cut = key.indexOf(":");
  const kind = key.slice(0, cut);
  const file = key.slice(cut + 1);
  if (kind === "list") {
    try {
      return `l:${readdirSync(file).sort().join("\u0000")}`;
    } catch {
      return "l:missing";
    }
  }
  if (kind === "log") {
    try {
      const st = statSync(file, { bigint: true });
      return `g:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
    } catch {
      return "g:missing";
    }
  }
  try {
    return `b:${createHash("sha1").update(readFileSync(file)).digest("hex")}`;
  } catch {
    return "b:missing";
  }
}

/** What a build read, stamped AS it read it (see `inputIdentity`). */
export class InputStamps {
  readonly stamps = new Map<string, string>();
  bytes(file: string): void {
    this.#add(`bytes:${file}`);
  }
  log(file: string): void {
    this.#add(`log:${file}`);
  }
  list(dir: string): void {
    this.#add(`list:${dir}`);
  }
  #add(key: string): void {
    this.stamps.set(key, inputIdentity(key));
  }
}

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

function walk(trajPath: string, parentId: string, prefix: string, depth: number, events: AgentEvent[], inputs: InputStamps): AgentNode[] {
  // The two files whose content decides this subtree, whether or not they exist yet: a cache has
  // to see the moment one APPEARS (absence -> presence), not just when a known file moves.
  const subDir = join(dirname(trajPath), "subagents");
  inputs.bytes(subagentIndexPath(trajPath));
  inputs.log(join(subDir, "events.jsonl"));
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
      children: depth < MAX_DEPTH && traj ? walk(traj, sessionId, path, depth + 1, events, inputs) : [],
    };
  });
}

export interface AgentsViewBuilt {
  view: AgentsView;
  /** Every input the build read, with the identity it saw (see `inputIdentity`). */
  inputs: InputStamps;
}

export function agentsViewWithInputs(sessionId: string, trajPaths: string[]): AgentsViewBuilt {
  // A rebuild is a fresh read: the roster's own parse cache is keyed `mtimeMs:size` with a 1 s age
  // window — coarser than a content identity. Left in place it could hand a rebuild the parse from
  // before the file moved, and the entry would then wear the newer identity for ever.
  invalidateSubagentIndex();
  eventCache.clear();
  const events: AgentEvent[] = [];
  const inputs = new InputStamps();
  // Oldest run first, so the tree reads in the order the agents were started.
  const nodes = [...trajPaths].reverse().flatMap((p) => walk(p, sessionId, "", 0, events, inputs));
  events.sort((a, b) => a.at - b.at);
  inputs.list(agentsDir());
  for (const f of agentDefsInputs()) inputs.bytes(f);
  return {
    view: { sessionId, nodes, events: events.slice(-MAX_EVENTS), defs: listAgentDefs() },
    inputs,
  };
}

export function agentsView(sessionId: string, trajPaths: string[]): AgentsView {
  return agentsViewWithInputs(sessionId, trajPaths).view;
}

/** What the sidebar polls: the rows only. It renders `nodes` and throws `events` and `defs` away
 *  (measured on the deployed surface: 34 407 B per answer for 2 rows, 93% of it `defs`), so it
 *  must not pay to ship them. */
export function briefOf(view: AgentsView): { sessionId: string; nodes: AgentNode[] } {
  return { sessionId: view.sessionId, nodes: view.nodes };
}
