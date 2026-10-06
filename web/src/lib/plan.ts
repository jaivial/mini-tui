/**
 * The DAG a plan draws on the task board, apart from any UI: which tasks sit in which layer
 * (longest path from a root), what the edges are, and the one-line summary a card shows. Pure
 * functions, so the drawing is testable without a browser (see tests/web-plan-board.test.ts).
 */
import type { PlanTask, SessionPlan } from "./types";

/** Edges as the board draws them: from a dependency to the task it unlocks. */
export function dagEdges(tasks: PlanTask[]): { from: string; to: string }[] {
  const ids = new Set(tasks.map((t) => t.id));
  const out: { from: string; to: string }[] = [];
  for (const t of tasks) for (const d of t.deps) if (ids.has(d)) out.push({ from: d, to: t.id });
  return out;
}

/**
 * Tasks in topological layers: layer 0 has no deps, layer n depends (transitively) on layer n-1.
 * Order inside a layer is the plan's own (submission) order, so the drawing is stable. A cycle
 * (never validated into a plan, but a hand-edited file could) is broken by ignoring the back edge.
 */
export function dagLayers(tasks: PlanTask[]): PlanTask[][] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const walking = new Set<string>();
  const walk = (t: PlanTask): number => {
    const known = depth.get(t.id);
    if (known !== undefined) return known;
    if (walking.has(t.id)) return 0; // a back edge: treat the dep as a root
    walking.add(t.id);
    let d = 0;
    for (const dep of t.deps) {
      const p = byId.get(dep);
      if (p && p.id !== t.id) d = Math.max(d, walk(p) + 1);
    }
    walking.delete(t.id);
    depth.set(t.id, d);
    return d;
  };
  const layers: PlanTask[][] = [];
  for (const t of tasks) {
    const d = walk(t);
    (layers[d] ??= []).push(t);
  }
  return layers;
}

/** Status counts in the order the board reads them: live work first, then the ends. */
export function planCounts(tasks: PlanTask[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return counts;
}

const STATUS_ORDER = ["running", "ready", "review", "done", "failed", "blocked", "pending"];

/**
 * The status counts in the order the board reads them (live work first), so the card's summary
 * line and the DAG header list the same states the same way.
 */
export function planCountEntries(tasks: PlanTask[]): [string, number][] {
  return Object.entries(planCounts(tasks)).sort(([a], [b]) => {
    const ia = STATUS_ORDER.indexOf(a);
    const ib = STATUS_ORDER.indexOf(b);
    return (ia === -1 ? STATUS_ORDER.length : ia) - (ib === -1 ? STATUS_ORDER.length : ib);
  });
}

/** The one-line summary a card shows beside its title: "4 tasks · 2 running · 1 done". */
export function planSummary(plan: SessionPlan): string {
  const parts = planCountEntries(plan.tasks).map(([status, n]) => `${n} ${status}`);
  return [`${plan.tasks.length} task${plan.tasks.length === 1 ? "" : "s"}`, ...parts].join(" · ");
}
