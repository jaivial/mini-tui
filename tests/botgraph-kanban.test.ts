/**
 * Regression: `botgraph kanban` has to work in the environment a bot really runs in.
 *
 * `mini-tui` is a bash wrapper that `exec`s `bun` by name, and bun lives in
 * `~/.bun/bin`, which is NOT on PATH for a non-login shell (cron, a systemd unit, an
 * agent shell). Measured on the production host 2026-10-16: `botgraph e2e` failed with
 *
 *     [FAIL] B ve el kanban/tarjeta de A — exec: bun: not found
 *
 * and the failure text was handed back *as the task card*; with the launcher off PATH
 * entirely, botgraph died with a FileNotFoundError traceback. These tests pin both:
 * the tool resolves what it needs itself, and a real failure is reported as a failure.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const script = join(root, "scripts", "botgraph.py");

//: the launcher the tests must NOT be able to reach: a bot's PATH has no bun and no ~/.local/bin
const BARE_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";
const python = Bun.which("python3") ?? "/usr/bin/python3";
const hasBun = existsSync(join(homedir(), ".bun", "bin", "bun"));
const hasLauncher = existsSync(join(homedir(), ".local", "bin", "mini-tui"));
const hasDriver = existsSync(join(homedir(), ".venvs", "neo4j-e2e", "bin", "python"));

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "botgraph-kanban-"));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Spawn botgraph the way a bot's shell would: a stripped PATH, no bun, no ~/.local/bin. */
function botgraph(args: string[], extraEnv: Record<string, string | undefined> = {}) {
  const env: Record<string, string> = { HOME: homedir(), PATH: BARE_PATH, ...process.env } as Record<string, string>;
  env.PATH = BARE_PATH;
  delete env.BOTGRAPH_MINITUI;
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const p = Bun.spawnSync({ cmd: [python, script, ...args], env, stdout: "pipe", stderr: "pipe" });
  return { rc: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("botgraph kanban in a bot's environment", () => {
  test.skipIf(!hasBun || !hasDriver)(
    "una tarjeta de tarea llega aunque el PATH del que llama no tenga bun",
    () => {
      // A stand-in for the real launcher: same shape, same dependency (`exec bun` by name),
      // so it fails exactly the way the real one did when bun was not on PATH.
      const launcher = join(dir, "mini-tui");
      writeFileSync(
        launcher,
        [
          "#!/usr/bin/env bash",
          'if ! command -v bun >/dev/null 2>&1; then echo "exec: bun: not found" >&2; exit 127; fi',
          'echo "CARD $*"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = botgraph(["kanban", "--session", "s1", "--no-hermes"], { BOTGRAPH_MINITUI: launcher });

      expect(r.rc).toBe(0);
      const report = JSON.parse(r.out);
      const card = report.task_cards[0]?.card;
      expect(card).toBe("CARD tasks show s1");
      expect(card).not.toContain("bun: not found");
      expect(report.ok).toBe(true);
      expect(report.errors).toEqual([]);
    },
  );

  test.skipIf(!hasLauncher || !hasDriver)(
    "sin lanzador en el PATH, botgraph lo encuentra por su cuenta",
    () => {
      const r = botgraph(["kanban", "--session", "no-such-bot", "--no-hermes"]);
      expect(r.err).not.toContain("Traceback");
      expect(r.rc).toBe(0);
      const report = JSON.parse(r.out);
      expect(report.read_only).toBe(true);
      expect(report.ok).toBe(true);
      expect(report.task_cards[0].card).toBeTruthy();
    },
  );

  test.skipIf(!hasDriver)(
    "un lanzador que no arranca se reporta como error, nunca como tarjeta",
    () => {
      const r = botgraph(["kanban", "--session", "s1", "--no-hermes"], {
        BOTGRAPH_MINITUI: join(dir, "does-not-exist"),
      });

      expect(r.rc).toBe(0);
      const report = JSON.parse(r.out);
      expect(report.ok).toBe(false);
      expect(report.errors.length).toBeGreaterThan(0);
      expect(report.errors[0]).toContain("could not run");
      expect(report.task_cards[0].card).toBeNull();
    },
  );
});
