/**
 * E10: a test file's cleanup must not unprotect the files that run after it.
 *
 * `bunfig.toml` preloads `tests/setup-preload.ts` once per process, which points
 * `MINITUI_SETTINGS_PATH` at a path that does not exist so `loadSettings` falls back to the
 * shipped defaults. The whole point is that the suite never reads the developer's home.
 *
 * That protection is only as strong as the weakest cleanup. `tests/router.test.ts` used to
 * `delete process.env.MINITUI_SETTINGS_PATH` in its `afterEach`, which removed the preload's value
 * for **every file that ran afterwards** — and from then on `loadSettings()` quietly returned the
 * real `~/.config/mini-tui/settings.json`. On this machine that is `theme: "nord"`, so the tests
 * that assert the default palette read `[136,192,208]` where the code correctly produces
 * `[167,139,250]`. It was order-dependent: it passed in isolation and failed in the full suite,
 * which is the worst shape a test failure can have.
 *
 * These tests pin the two halves of the fix: the cleanup restores what it found, and the source
 * refuses the home directory outright when a test run points it nowhere.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../src/settings";

let dir: string;

/** The path `src/settings.ts` would use with no env var set — the operator's real settings. */
const HOME_SETTINGS = join(process.env.HOME ?? "/root", ".config", "mini-tui", "settings.json");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "minitui-settings-leak-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("settings never escape the test sandbox", () => {
  test("a test run with no settings path of its own gets the shipped defaults, not the operator's theme", () => {
    // Exactly the state a previous file's `afterEach` used to leave behind.
    delete process.env.MINITUI_SETTINGS_PATH;
    try {
      const loaded = loadSettings();
      expect(loaded.theme).toBe(DEFAULT_SETTINGS.theme);
      expect(loaded.theme).toBe("shadcn");
      // Whatever this machine has saved, it must not be what the suite renders with.
      if (existsSync(HOME_SETTINGS)) {
        const real = JSON.parse(readFileSync(HOME_SETTINGS, "utf8")) as { theme?: string };
        if (real.theme && real.theme !== DEFAULT_SETTINGS.theme) {
          expect(loaded.theme).not.toBe(real.theme);
        }
      }
    } finally {
      process.env.MINITUI_SETTINGS_PATH = "/dev/null/mini-tui-no-settings.json";
    }
  });

  test("saving under test with no path of its own writes nothing at all", () => {
    const before = existsSync(HOME_SETTINGS) ? readFileSync(HOME_SETTINGS, "utf8") : null;
    delete process.env.MINITUI_SETTINGS_PATH;
    try {
      // The write side is the dangerous half: `saveSettings` on the leaked path overwrites the
      // operator's real file with whatever the last test happened to be holding. Measured against
      // `origin/main`: this assertion fails *and* the real file comes back with
      // `modelRouterEnabled: true` written into it by the call below.
      saveSettings({ ...DEFAULT_SETTINGS, theme: "nord", modelRouterEnabled: true });
      const after = existsSync(HOME_SETTINGS) ? readFileSync(HOME_SETTINGS, "utf8") : null;
      expect(after).toBe(before);
    } finally {
      // This test's whole subject is "nothing gets written here", so it repairs the file itself
      // rather than leaving the damage for whoever runs the suite next. The assertion above has
      // already thrown by now, so a failure still fails — it just does not cost anyone their
      // settings to prove it.
      const now = existsSync(HOME_SETTINGS) ? readFileSync(HOME_SETTINGS, "utf8") : null;
      if (now !== before) {
        if (before === null) rmSync(HOME_SETTINGS, { force: true });
        else writeFileSync(HOME_SETTINGS, before);
      }
      process.env.MINITUI_SETTINGS_PATH = "/dev/null/mini-tui-no-settings.json";
    }
  });

  test("an explicit settings path still wins — the guard is not a blanket disable", () => {
    const file = join(dir, "settings.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ outputMode: "collapsed", theme: "nord" }));
    process.env.MINITUI_SETTINGS_PATH = file;
    try {
      expect(loadSettings().theme).toBe("nord");
      saveSettings({ ...DEFAULT_SETTINGS, theme: "gruvbox" });
      expect(JSON.parse(readFileSync(file, "utf8")).theme).toBe("gruvbox");
      expect(loadSettings().theme).toBe("gruvbox");
    } finally {
      process.env.MINITUI_SETTINGS_PATH = "/dev/null/mini-tui-no-settings.json";
    }
  });

  test("outside a test run the operator's own settings are still what is read and written", () => {
    // The guard keys off `NODE_ENV=test` / `MINITUI_TEST=1`; with neither set this is production
    // behaviour, and it must keep working — a guard that only ever returns null would be a
    // settings store that silently forgets everything.
    const saved = { nodeEnv: process.env.NODE_ENV, flag: process.env.MINITUI_TEST };
    delete process.env.NODE_ENV;
    delete process.env.MINITUI_TEST;
    delete process.env.MINITUI_SETTINGS_PATH;
    try {
      const home = existsSync(HOME_SETTINGS);
      expect(typeof loadSettings().outputMode).toBe("string");
      if (home) {
        const raw = readFileSync(HOME_SETTINGS, "utf8");
        saveSettings(JSON.parse(raw));
        expect(readFileSync(HOME_SETTINGS, "utf8")).toBe(raw);
      }
    } finally {
      if (saved.nodeEnv !== undefined) process.env.NODE_ENV = saved.nodeEnv;
      if (saved.flag !== undefined) process.env.MINITUI_TEST = saved.flag;
      process.env.MINITUI_SETTINGS_PATH = "/dev/null/mini-tui-no-settings.json";
    }
  });
});

describe("a test file's cleanup leaves the process as it found it", () => {
  test("restoring is what protects the files that run next", () => {
    // The preload's value, as `tests/setup-preload.ts` sets it.
    const preload = process.env.MINITUI_SETTINGS_PATH;
    expect(typeof preload).toBe("string");

    // What the fix in `tests/router.test.ts` does: remember, set, then put back.
    const saved = process.env.MINITUI_SETTINGS_PATH;
    process.env.MINITUI_SETTINGS_PATH = join(dir, "inner.json");
    const inner = process.env.MINITUI_SETTINGS_PATH;
    if (saved === undefined) delete process.env.MINITUI_SETTINGS_PATH;
    else process.env.MINITUI_SETTINGS_PATH = saved;

    expect(inner).not.toBe(saved);
    // The next file sees the preload's sandbox again, not `undefined`.
    expect(process.env.MINITUI_SETTINGS_PATH).toBe(preload);
    expect(loadSettings().theme).toBe(DEFAULT_SETTINGS.theme);
  });
});
