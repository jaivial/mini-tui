/** The sidebar's "By folder" grouping: pure rules. */
import { describe, expect, test } from "bun:test";
import { folderTitle, groupByFolder, normalizeCwd, toggleIn } from "../web/src/lib/sessionFolders";

const open = (id: string, cwd: string, updatedAt: number, status = "done") => ({ id, cwd, updatedAt, status, title: id }) as any;
const saved = (id: string, cwd: string, updatedAt: number) => ({ id, cwd, updatedAt, title: id }) as any;
const folder = (cwd: string, count: number, updatedAt: number) => ({ cwd, count, updatedAt });

describe("groupByFolder", () => {
  test("one group per folder, open and saved sessions in it, newest folder first", () => {
    const g = groupByFolder(
      [open("o1", "/w/api", 500)],
      [saved("h1", "/w/api", 100), saved("h2", "/w/web", 300), saved("o1", "/w/api", 500)],
      [folder("/w/api", 2, 500), folder("/w/web", 1, 300)],
    );
    expect(g.map((x) => x.cwd)).toEqual(["/w/api", "/w/web"]);
    expect(g[0]!.open.map((s) => s.id)).toEqual(["o1"]);
    expect(g[0]!.saved.map((s) => s.id)).toEqual(["h1"]); // an open session is not repeated as saved
    expect(g[0]!.total).toBe(2);
  });
  test("a folder only the database knows (nothing loaded yet) still shows, with its count", () => {
    const g = groupByFolder([], [], [folder("/old/project", 12, 50)]);
    expect(g).toEqual([expect.objectContaining({ cwd: "/old/project", total: 12, open: [], saved: [] })]);
  });
  test("a trailing slash is the same folder", () => {
    expect(normalizeCwd("/w/api/")).toBe("/w/api");
    expect(normalizeCwd("/")).toBe("/");
    const g = groupByFolder([open("a", "/w/api/", 2)], [saved("b", "/w/api", 1)], []);
    expect(g.length).toBe(1);
  });
  test("pinned folders come first in pin order; then folders with a running session; then by recency", () => {
    const g = groupByFolder(
      [open("r", "/b", 1, "running")],
      [saved("x", "/a", 900), saved("y", "/c", 800), saved("z", "/d", 700)],
      [],
      ["/d", "/c"],
    );
    expect(g.map((x) => x.cwd)).toEqual(["/d", "/c", "/b", "/a"]);
    expect(g[0]!.pinned).toBe(true);
    expect(g[2]!.running).toBe(1);
  });
  test("a live session not saved yet still counts in its folder", () => {
    const g = groupByFolder([open("new", "/w", 5, "running")], [], []);
    expect(g[0]!.total).toBe(1);
  });
});

describe("labels and prefs", () => {
  test("a folder reads as its name, with where it lives under it", () => {
    expect(folderTitle("/home/me/work/api", "/home/me")).toEqual({ name: "api", parent: "~/work" });
    expect(folderTitle("/home/me", "/home/me")).toEqual({ name: "~", parent: "" });
    expect(folderTitle("/srv/app", "/home/me")).toEqual({ name: "app", parent: "/srv" });
    expect(folderTitle("/tmp", "")).toEqual({ name: "tmp", parent: "/" });
    expect(folderTitle("/", "")).toEqual({ name: "/", parent: "" });
    expect(folderTitle("", "")).toEqual({ name: "No folder", parent: "" });
  });
  test("toggling adds then removes", () => {
    expect(toggleIn(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleIn(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("expanded folders", async () => {
  const { isExpanded } = await import("../web/src/lib/sessionFolders");
  const g = (open: number, pinned = false) => ({ cwd: "/w", open: Array(open).fill({}), pinned }) as any;
  test("by default a folder is open when it has open sessions or is pinned, closed otherwise", () => {
    expect(isExpanded(g(1), { expanded: {} })).toBe(true);
    expect(isExpanded(g(0, true), { expanded: {} })).toBe(true);
    expect(isExpanded(g(0), { expanded: {} })).toBe(false);
  });
  test("your choice wins, both ways", () => {
    expect(isExpanded(g(1), { expanded: { "/w": false } })).toBe(false);
    expect(isExpanded(g(0), { expanded: { "/w": true } })).toBe(true);
  });
});

describe("live sessions keep their place", () => {
  const live = (id: string, cwd: string, createdAt: number, updatedAt: number, status = "running") => ({ id, cwd, createdAt, updatedAt, status, title: id }) as any;
  test("open sessions in a folder are ordered by when they started, not by their last update", async () => {
    const { byStart } = await import("../web/src/lib/sessionFolders");
    const a = live("a", "/w", 100, 900);
    const b = live("b", "/w", 200, 300);
    // b started last, so it is first, even though a was updated more recently.
    expect([a, b].sort(byStart).map((s) => s.id)).toEqual(["b", "a"]);
    // A step in a (its updatedAt moves on) changes nothing.
    a.updatedAt = 5000;
    expect([a, b].sort(byStart).map((s) => s.id)).toEqual(["b", "a"]);
    expect(groupByFolder([a, b], [], [])[0]!.open.map((s) => s.id)).toEqual(["b", "a"]);
  });
  test("folders with live sessions do not trade places as those sessions step", () => {
    const x = live("x", "/x", 100, 900);
    const y = live("y", "/y", 200, 300);
    const order = () => groupByFolder([x, y], [], []).map((g) => g.cwd);
    expect(order()).toEqual(["/y", "/x"]);
    x.updatedAt = 9999; // a step in /x
    expect(order()).toEqual(["/y", "/x"]);
  });
  test("ties are broken by id, so equal start times still give one order", async () => {
    const { byStart } = await import("../web/src/lib/sessionFolders");
    const p = live("p", "/w", 100, 1);
    const q = live("q", "/w", 100, 2);
    expect([q, p].sort(byStart).map((s) => s.id)).toEqual(["p", "q"]);
    expect([p, q].sort(byStart).map((s) => s.id)).toEqual(["p", "q"]);
  });
});
