/** The DAG the task board draws: layers, edges, and the card's one-line summary. */
import { describe, expect, test } from "bun:test";
import { dagEdges, dagLayers, planCounts, planSummary } from "../web/src/lib/plan";
import type { PlanTask, SessionPlan } from "../web/src/lib/types";

const task = (id: string, status: string, deps: string[] = [], title = `task ${id}`): PlanTask => ({ id, title, status, deps, group: "", priority: 0 });
const planOf = (tasks: PlanTask[]): SessionPlan => ({ session: "s-1", updatedAt: 1, tasks });

describe("dagLayers", () => {
  test("tasks land one layer below their deepest dependency", () => {
    const layers = dagLayers([task("A1", "done"), task("A2", "running", ["A1"]), task("B", "pending"), task("A3", "pending", ["A2"])]);
    expect(layers.map((l) => l.map((t) => t.id))).toEqual([["A1", "B"], ["A2"], ["A3"]]);
  });

  test("a diamond keeps both branches on the same layer", () => {
    const layers = dagLayers([task("top", "done"), task("left", "review", ["top"]), task("right", "running", ["top"]), task("join", "pending", ["left", "right"])]);
    expect(layers.map((l) => l.map((t) => t.id))).toEqual([["top"], ["left", "right"], ["join"]]);
  });

  test("order inside a layer is the plan's own, and a hand-edited cycle is broken, not hung", () => {
    const layers = dagLayers([task("Z", "pending"), task("A", "pending"), task("loop1", "pending", ["loop2"]), task("loop2", "pending", ["loop1"])]);
    // the back edge is ignored: loop1 rests on loop2, so it draws one layer below it
    expect(layers.flat().map((t) => t.id)).toEqual(["Z", "A", "loop2", "loop1"]);
  });
});

describe("dagEdges", () => {
  test("edges run from a dependency to the task it unlocks; unknown ids are not drawn", () => {
    expect(dagEdges([task("A1", "done"), task("A2", "pending", ["A1"]), task("A3", "pending", ["ghost"])])).toEqual([{ from: "A1", to: "A2" }]);
  });
});

describe("the plan card", () => {
  test("the summary counts every state in the order the board reads them", () => {
    const plan = planOf([
      task("A1", "review"),
      task("A2", "running", ["A1"]),
      task("B", "failed"),
      task("C", "blocked", ["B"]),
      task("D", "pending"),
    ]);
    expect(planSummary(plan)).toBe("5 tasks · 1 running · 1 review · 1 failed · 1 blocked · 1 pending");
    expect(planCounts(plan.tasks)).toEqual({ review: 1, running: 1, failed: 1, blocked: 1, pending: 1 });
  });

  test("a one-task plan says task, not tasks", () => {
    expect(planSummary(planOf([task("A1", "done")]))).toBe("1 task · 1 done");
  });

  test("a finished chain snapshots as its whole story", () => {
    const plan = planOf([task("Z1", "done", [], "step one"), task("Z2", "review", ["Z1"], "step two"), task("Z3", "pending", ["Z2"], "step three")]);
    expect(planSummary(plan)).toMatchInlineSnapshot(`"3 tasks · 1 review · 1 done · 1 pending"`);
    expect(dagLayers(plan.tasks).map((l) => l.map((t) => `${t.id}:${t.status}`))).toMatchInlineSnapshot(`
      [
        [
          "Z1:done",
        ],
        [
          "Z2:review",
        ],
        [
          "Z3:pending",
        ],
      ]
    `);
  });
});
