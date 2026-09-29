/** The Resume list's pure logic: recency buckets, labels, and the reasons a row is read-only. */
import { describe, expect, test } from "bun:test";
import { bucketOf, groupByRecency, shortFolder, shortModel, unresumableReason } from "../web/src/lib/resume";
import type { HistoryItem } from "../web/src/lib/types";

const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const NOW = at(2026, 9, 29, 0, 30); // half past midnight: the awkward moment
const item = (id: string, updatedAt: number, extra: Partial<HistoryItem> = {}): HistoryItem => ({
  id, title: id, cwd: "/w", model: "m", task: "t", createdAt: updatedAt, updatedAt, apiCalls: 1, cost: 0, exitStatus: "", resumable: true, open: false, ...extra,
});

describe("bucketOf", () => {
  test("calendar days, not 24-hour windows: 23:50 yesterday is Yesterday, not Today, at 00:30", () => {
    expect(bucketOf(at(2026, 9, 28, 23, 50), NOW)).toBe("Yesterday");
    expect(bucketOf(at(2026, 9, 29, 0, 10), NOW)).toBe("Today");
  });
  test("this week is the six days before yesterday; older is Earlier", () => {
    expect(bucketOf(at(2026, 9, 27, 10), NOW)).toBe("This week");
    expect(bucketOf(at(2026, 9, 23, 10), NOW)).toBe("This week");
    expect(bucketOf(at(2026, 9, 22, 10), NOW)).toBe("Earlier");
  });
  test("a timestamp in the future (clock skew) is Today, never a crash or a missing group", () => {
    expect(bucketOf(NOW + 5 * 86_400_000, NOW)).toBe("Today");
  });
});

describe("groupByRecency", () => {
  test("groups in reading order, keeps each group's order, and drops empty groups", () => {
    const items = [item("a", at(2026, 9, 29, 0, 20)), item("b", at(2026, 9, 28, 20)), item("c", at(2026, 9, 28, 9)), item("d", at(2026, 9, 1))];
    const g = groupByRecency(items, NOW);
    expect(g.map((x) => x.bucket)).toEqual(["Today", "Yesterday", "Earlier"]);
    expect(g[1]!.items.map((i) => i.id)).toEqual(["b", "c"]);
  });
  test("nothing in, nothing out", () => {
    expect(groupByRecency([], NOW)).toEqual([]);
  });
});

describe("labels", () => {
  test("a folder shows its last two segments, and copes with root, trailing slashes and empty", () => {
    expect(shortFolder("/home/me/work/api")).toBe("work/api");
    expect(shortFolder("/home/me/work/api/")).toBe("work/api");
    expect(shortFolder("/api")).toBe("api");
    expect(shortFolder("/")).toBe("/");
    expect(shortFolder("")).toBe("/");
  });
  test("a model loses its provider prefix; an empty one is named", () => {
    expect(shortModel("cliproxy/claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(shortModel("rosetta/zai-glm/glm-5.3-flash")).toBe("zai-glm/glm-5.3-flash");
    expect(shortModel("")).toBe("default model");
    expect(shortModel("bare")).toBe("bare");
  });
  test("only a row that cannot be continued explains why", () => {
    expect(unresumableReason(item("x", NOW, { resumable: true }))).toBe("");
    expect(unresumableReason(item("x", NOW, { resumable: false }))).toMatch(/Nothing was saved/);
  });
});
