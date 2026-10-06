/**
 * A session's DAG plan, as the task board draws it.
 *
 * The Rust hub owns the plan (it launches the tasks and writes `subagents/plan.json` next to its
 * `index.json`); this side only reads it — cached by mtime, tolerant of junk: an unreadable plan
 * is no plan, never a broken board.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** One node of the DAG, as the UI shows it. */
export interface PlanTask {
  id: string;
  title: string;
  /** pending | ready | running | review | done | failed | blocked */
  status: string;
  /** Ids that must be satisfied before this one launches. */
  deps: string[];
  group: string;
  priority: number;
  /** The child's answer (or failure reason): what the handoff and the review work from. */
  result?: string;
  error?: string;
}

/** One session's whole plan (the board shows one DAG per session). */
export interface SessionPlan {
  session: string;
  tasks: PlanTask[];
  updatedAt: number;
}

export function planPath(trajPath: string): string {
  return join(dirname(trajPath), "subagents", "plan.json");
}

const cache = new Map<string, { stamp: string; doc: SessionPlan | null }>();

/** The plan of the run that journals to `trajPath`, or null when it has none. */
export function readPlan(session: string, trajPath: string): SessionPlan | null {
  const path = planPath(trajPath);
  let stamp: string;
  try {
    const st = statSync(path);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    cache.delete(path);
    return null;
  }
  const hit = cache.get(path);
  if (hit && hit.stamp === stamp) return hit.doc;
  let doc: SessionPlan | null = null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { tasks?: unknown; updated_at?: number };
    const tasks: PlanTask[] = [];
    for (const raw of Array.isArray(parsed.tasks) ? parsed.tasks : []) {
      const t = raw as Partial<PlanTask>;
      if (typeof t?.id !== "string" || !t.id) continue;
      tasks.push({
        id: t.id,
        title: typeof t.title === "string" ? t.title : "",
        status: typeof t.status === "string" ? t.status : "pending",
        deps: Array.isArray(t.deps) ? t.deps.filter((d): d is string => typeof d === "string") : [],
        group: typeof t.group === "string" ? t.group : "",
        priority: typeof t.priority === "number" ? t.priority : 0,
        ...(typeof t.result === "string" ? { result: t.result } : {}),
        ...(typeof t.error === "string" ? { error: t.error } : {}),
      });
    }
    if (tasks.length) doc = { session, tasks, updatedAt: Number(parsed.updated_at) || Date.now() };
  } catch {
    doc = null;
  }
  cache.set(path, { stamp, doc });
  return doc;
}
