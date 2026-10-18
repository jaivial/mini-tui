/**
 * The folder picker's cap has to bound the WORK and not only the answer (E45).
 *
 * Measured on the deployed build: a directory with 30 000 subfolders produced 60 000 stats and 30 000
 * thrown exceptions to return 500 entries, 1 165 ms of it in one stretch on the server's only thread
 * -- a request to any other endpoint waited 1 186 ms behind it. These tests pin the two halves: the
 * probes asked are the ones the answer needs, and the thread is handed back while the rest is read.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOLDER_LIMIT, listLocal, selectFolders, type FolderCandidate } from "../src/web/folders";

const root = mkdtempSync(join(tmpdir(), "minitui-folders-cap-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const dirs = (names: string[]): FolderCandidate[] => names.map((name) => ({ name, link: false }));

/** The order the old comparator produced, kept here as the reference the new one has to match. */
const oldOrder = (names: string[]) =>
  [...names].sort((a, b) => Number(a.startsWith(".")) - Number(b.startsWith(".")) || a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

describe("the cap bounds the work, not only the answer", () => {
  test("20 000 folders: one probe per returned entry, none for a folder the dirent already described", async () => {
    const names = Array.from({ length: 20_000 }, (_, i) => `proj-${String((i * 3) % 20_000).padStart(6, "0")}`);
    let isFolder = 0;
    let hasGit = 0;
    const l = await selectFolders(dirs(names), { isFolder: () => { isFolder++; return true; }, hasGit: () => { hasGit++; return false; } });
    expect(l.entries.length).toBe(FOLDER_LIMIT);
    expect(l.truncated).toBe(true);
    expect(hasGit).toBe(FOLDER_LIMIT);
    expect(isFolder).toBe(0);
    expect(l.entries.map((e) => e.name)).toEqual(oldOrder(names).slice(0, FOLDER_LIMIT));
  });

  test("links that are not folders still leave `limit` folders behind, and truncation stays honest", async () => {
    const names = ["a", "b", "c", "d", "e", "f", "g"];
    const links = new Set(["b", "c"]); // two dangling links, both sorting before the cap
    let probed: string[] = [];
    const l = await selectFolders(
      names.map((name) => ({ name, link: links.has(name) })),
      { isFolder: (name) => { probed.push(name); return !links.has(name); }, hasGit: () => false },
      3,
    );
    expect(l.entries.map((e) => e.name)).toEqual(["a", "d", "e"]);
    expect(l.truncated).toBe(true);
    expect(probed).toEqual(["b", "c"]);
  });

  test("`limit` folders say there are no more, one more says there are", async () => {
    for (const [n, truncated] of [[2, false], [3, false], [4, true], [50, true]] as const) {
      const names = Array.from({ length: n }, (_, i) => `f${String(i).padStart(3, "0")}`);
      const l = await selectFolders(dirs(names), { isFolder: () => true, hasGit: () => false }, 3);
      expect(l.entries.length).toBe(Math.min(n, 3));
      expect(l.truncated).toBe(truncated);
    }
  });

  test("a folder with 20 000 subfolders cannot monopolise the thread it runs on", async () => {
    const big = join(root, "big");
    mkdirSync(big);
    for (let i = 0; i < 20_000; i++) mkdirSync(join(big, `d${String(i).padStart(5, "0")}`));
    let stop = false;
    let last = performance.now();
    let first = -1;
    let worst = 0;
    const ping = () => {
      const now = performance.now();
      // The first tick after asking for the listing is how long the thread was NOT available.
      if (first < 0) first = now - last;
      else worst = Math.max(worst, now - last);
      last = now;
      if (!stop) setImmediate(ping);
    };
    last = performance.now();
    setImmediate(ping);
    const l = await listLocal(big);
    stop = true;
    await new Promise((r) => setTimeout(r, 0)); // let the pending tick land, whatever it says
    expect(l.entries.length).toBe(FOLDER_LIMIT);
    expect(l.truncated).toBe(true);
    // The old listing did all of it in one synchronous stretch: 1 186 ms of other requests waiting
    // on a 30 000-folder directory, 784 ms measured on this one. Two orders of magnitude of
    // margin, not a threshold tuned to what the new code happens to take.
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(120);
    expect(worst).toBeLessThan(120);
    rmSync(big, { recursive: true, force: true });
  });
});

describe("the answer is the same one the old listing gave", () => {
  test("awkward names come back in the old order, git marked, files and dangling links left out", async () => {
    const odd = join(root, "odd");
    mkdirSync(odd);
    for (const name of ["Proj2", "Proj10", "proj3", "Éclair", "zebra", "with space", "it's quoted"]) mkdirSync(join(odd, name));
    mkdirSync(join(odd, ".cache"));
    mkdirSync(join(odd, ".hidden-repo"));
    mkdirSync(join(odd, ".hidden-repo", ".git"));
    mkdirSync(join(odd, "repo"));
    mkdirSync(join(odd, "repo", ".git"));
    mkdirSync(join(odd, "worktree"));
    writeFileSync(join(odd, "worktree", ".git"), "gitdir: /elsewhere\n");
    writeFileSync(join(odd, "README.md"), "a file, not a folder");
    symlinkSync(join(odd, "repo"), join(odd, "repo-link"));
    symlinkSync(join(odd, "nowhere"), join(odd, "dangling"));
    const l = await listLocal(odd);
    const names = l.entries.map((e) => e.name);
    expect(names).toEqual(oldOrder(names.filter((n) => n !== "dangling")));
    expect(names.slice(0, 2)).toEqual(["Éclair", "it's quoted"]); // accents ignored, quotes and spaces fine
    expect(names.indexOf("Proj2")).toBeLessThan(names.indexOf("Proj10")); // numbers in order
    expect(names.at(-2)).toBe(".cache"); // hidden ones last
    expect(names.at(-1)).toBe(".hidden-repo");
    expect(l.entries.find((e) => e.name === "repo")!.git).toBe(true); // .git as a folder
    expect(l.entries.find((e) => e.name === "worktree")!.git).toBe(true); // .git as a file
    expect(l.entries.find((e) => e.name === "zebra")!.git).toBe(false);
    expect(l.entries.find((e) => e.name === "repo-link")!.path).toBe(join(odd, "repo-link"));
    expect(l.truncated).toBe(false);
  });
});
