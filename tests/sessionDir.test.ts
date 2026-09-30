import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("createSessionDir", () => {
  test("same task in the same second never shares a folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "mt-runs-"));
    process.env.MINITUI_RUNS_DIR = root;
    try {
      const { createSessionDir } = await import(`../src/config.ts?runs=${Date.now()}`);
      const task = "Read the contract first. Follow good-code and the same long prefix";
      const dirs = Array.from({ length: 20 }, () => createSessionDir(task).dir);
      expect(new Set(dirs).size).toBe(dirs.length);
      expect(dirs.every((d: string) => d.startsWith(root))).toBe(true);
    } finally {
      delete process.env.MINITUI_RUNS_DIR;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
