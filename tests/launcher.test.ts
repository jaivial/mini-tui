/**
 * The shipped launcher (`bin/mini-tui`, copied to ~/.local/bin/mini-tui by the README).
 *
 * It is the only thing standing between "I typed mini-tui" and "which code did that
 * actually run". Two defects were measured on the box that prompted these tests:
 *
 *   1. `exec bun ...` with no lookup. bun is not on PATH in cron, in a systemd unit
 *      or in a non-interactive `ssh host 'mini-tui -p ...'`, so the launcher died with
 *      a bare `exec: bun: not found` and exit 127. A real transient unit
 *      (agent-rel2-2311713.service) invokes `mini-tui -p` and failed this way.
 *   2. No mention of WHICH checkout runs. ~/mini-tui was 157 commits behind the
 *      deployed tree and `mini-tui --version` printed `mini-tui 0.41.0` from both —
 *      byte-identical — so running old code was invisible.
 *
 * These run the real bash script against real git repos in a temp dir: a launcher is
 * wiring, and a test that only greps its text proves nothing about what it executes.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const LAUNCHER = join(import.meta.dir, "..", "bin", "mini-tui");
const roots: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "minitui-launcher-"));
  roots.push(dir);
  return dir;
}

/** A checkout that is a real git repo whose src/index.ts echoes its args. */
function checkout(dir: string, commits = 1): string {
  const home = join(dir, "home");
  const tree = join(home, "mini-tui");
  mkdirSync(join(tree, "src"), { recursive: true });
  writeFileSync(join(tree, "src", "index.ts"), "console.log(process.argv.slice(2).join(' '));\n");
  const git = (...args: string[]) => spawnSync("git", ["-C", tree, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-qm", `c${commits}`);
  // origin/main is what the staleness check compares against. Track it locally so the
  // probe has something to read without a network fetch.
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  return home;
}

/** A fake bun that prints a marker, so we can tell it was the one that ran.
 *  `name` keeps two fakes in one sandbox from overwriting each other. */
function fakeBun(dir: string, marker = "FAKE-BUN", name = "fakebun"): string {
  const bin = join(dir, name);
  mkdirSync(bin, { recursive: true });
  const file = join(bin, "bun");
  writeFileSync(file, `#!/bin/sh\necho "${marker} $@"\n`);
  chmodSync(file, 0o755);
  return bin;
}

/**
 * Make the checkout `n` commits BEHIND origin/main: origin/main must point at commits
 * HEAD does not have. Moving HEAD forward (the obvious move) makes the tree *ahead*,
 * which is the opposite of what the launcher warns about.
 */
function makeBehind(tree: string, n = 1): void {
  const git = (...args: string[]) => spawnSync("git", ["-C", tree, ...args], { encoding: "utf8" });
  const base = git("rev-parse", "HEAD").stdout.trim();
  for (let i = 0; i < n; i++) git("commit", "-q", "--allow-empty", "-m", `newer${i}`);
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("reset", "-q", "--hard", base);
}

function run(env: Record<string, string>, args: string[] = []) {
  // Absolute interpreter: several cases deliberately blank PATH, and resolving
  // `bash` through it would fail to spawn and report status undefined.
  const proc = spawnSync("/bin/bash", [LAUNCHER, ...args], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", HOME: env.HOME ?? "/nonexistent", ...env },
  });
  return { code: proc.status, out: proc.stdout, err: proc.stderr };
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("launcher: finds bun when PATH does not have it", () => {
  test("runs with bun absent from PATH (the measured 127)", () => {
    const dir = sandbox();
    const home = checkout(dir);
    const bunDir = fakeBun(dir);
    // bun is reachable only at the standard install location, never on PATH.
    const proc = run({ HOME: home, PATH: `${bunDir}:/usr/bin:/bin`, BUN_INSTALL: bunDir }, ["--version"]);
    expect(proc.code).toBe(0);
    expect(proc.out).toContain("FAKE-BUN");
    expect(proc.out).toContain("--version");
  });

  test("explains itself instead of `exec: bun: not found` when bun is truly absent", () => {
    const dir = sandbox();
    const home = checkout(dir);
    const empty = join(dir, "empty");
    mkdirSync(empty, { recursive: true });
    const proc = run({ HOME: home, PATH: empty, BUN_INSTALL: join(empty, "nothing-here") });
    expect(proc.code).toBe(127);
    expect(proc.err).toMatch(/bun not found/);
    expect(proc.err).not.toMatch(/exec: bun: not found/);
    // The message must name the knob, or the operator cannot act on it.
    expect(proc.err).toMatch(/BUN_INSTALL|bun\.sh/);
  });

  test("a bun on PATH wins over the install-location guess", () => {
    const dir = sandbox();
    const home = checkout(dir);
    const onPath = fakeBun(dir, "PATH-BUN", "onpath");
    const install = fakeBun(dir, "INSTALL-BUN", "install");
    const proc = run({ HOME: home, PATH: `${onPath}:/usr/bin:/bin`, BUN_INSTALL: install }, ["x"]);
    expect(proc.out).toContain("PATH-BUN");
    expect(proc.out).not.toContain("INSTALL-BUN");
  });
});

describe("launcher: says WHICH checkout it is about to run", () => {
  test("warns when MINITUI_HOME is behind origin/main", () => {
    const dir = sandbox();
    const home = checkout(dir);
    const bunDir = fakeBun(dir);
    makeBehind(join(home, "mini-tui"));
    const proc = run({ HOME: home, PATH: `${bunDir}:/usr/bin:/bin`, BUN_INSTALL: bunDir });
    expect(proc.out).toContain("FAKE-BUN");
    expect(proc.err).toMatch(/behind origin\/main/);
    expect(proc.err).toContain("1 commit");
    expect(proc.err).toContain(join(home, "mini-tui"));
  });

  test("silent when the checkout is level with origin/main", () => {
    const dir = sandbox();
    const home = checkout(dir);
    const bunDir = fakeBun(dir);
    const proc = run({ HOME: home, PATH: `${bunDir}:/usr/bin:/bin`, BUN_INSTALL: bunDir });
    expect(proc.err).toBe("");
    expect(proc.out).toContain("FAKE-BUN");
  });

  test("a missing checkout names the path instead of exec'ing bun at nothing", () => {
    const dir = sandbox();
    const home = checkout(dir);
    const bunDir = fakeBun(dir);
    rmSync(join(home, "mini-tui"), { recursive: true, force: true });
    const proc = run({ HOME: home, PATH: `${bunDir}:/usr/bin:/bin`, BUN_INSTALL: bunDir });
    expect(proc.code).toBe(127);
    expect(proc.err).toMatch(/no mini-tui checkout/);
    expect(proc.err).toContain(join(home, "mini-tui"));
    expect(proc.err).not.toContain("FAKE-BUN");
  });

  test("MINITUI_HOME overrides the default home, and the warning follows it", () => {
    const dir = sandbox();
    const home = checkout(dir); // default: level
    const other = join(dir, "other");
    mkdirSync(join(other, "src"), { recursive: true });
    writeFileSync(join(other, "src", "index.ts"), "\n");
    const git = (...args: string[]) => spawnSync("git", ["-C", other, ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "old");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    makeBehind(other);
    const bunDir = fakeBun(dir);
    const proc = run({ HOME: home, MINITUI_HOME: other, PATH: `${bunDir}:/usr/bin:/bin`, BUN_INSTALL: bunDir });
    expect(proc.out).toContain(join(other, "src", "index.ts"));
    expect(proc.err).toContain(other);
    expect(proc.err).not.toContain(home);
  });
});

describe("launcher: a repo that is not a git checkout must not crash", () => {
  test("plain directory with src/index.ts just runs", () => {
    const dir = sandbox();
    const home = join(dir, "home", "mini-tui");
    mkdirSync(join(home, "src"), { recursive: true });
    writeFileSync(join(home, "src", "index.ts"), "\n");
    const bunDir = fakeBun(dir);
    const proc = run({ HOME: join(dir, "home"), PATH: `${bunDir}:/usr/bin:/bin`, BUN_INSTALL: bunDir });
    expect(proc.code).toBe(0);
    expect(proc.err).toBe("");
  });
});
