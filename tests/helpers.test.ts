import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { resolveCommand, resolvePython } from "../src/helpers";

const dir = mkdtempSync(join(tmpdir(), "mini-tui-helpers-"));
const fake = (name: string, shebang: string) => {
  const path = join(dir, name);
  writeFileSync(path, `${shebang}\nprint("hi")\n`);
  chmodSync(path, 0o755);
  return path;
};
fake("mini", "#!/usr/bin/python3.10");
fake("mini-env", "#!/usr/bin/env python3.11");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("helper interpreter resolution", () => {
  test("bare command names resolve through PATH", () => {
    expect(resolveCommand("mini", { PATH: `/usr/bin:${dir}` })).toBe(join(dir, "mini"));
    expect(resolveCommand("definitely-missing", { PATH: dir })).toBe("definitely-missing");
    expect(resolveCommand("/abs/path/mini", { PATH: dir })).toBe("/abs/path/mini");
  });

  test("the interpreter comes from mini's shebang", () => {
    expect(resolvePython("mini", { PATH: `/usr/bin:${dir}` })).toBe("/usr/bin/python3.10");
  });

  test("env-style shebangs work too", () => {
    expect(resolvePython("mini-env", { PATH: `/usr/bin:${dir}` })).toBe("python3.11");
  });

  test("MINITUI_PYTHON wins; missing files fall back to python3", () => {
    expect(resolvePython("mini", { PATH: dir, MINITUI_PYTHON: "/opt/py" })).toBe("/opt/py");
    expect(resolvePython("no-such-mini", { PATH: dir })).toBe("python3");
  });
});

describe("startup settle window", () => {
  test("waits for input to go quiet (and respects the minimum)", async () => {
    let last = Date.now();
    const spam = setInterval(() => {
      last = Date.now();
    }, 10);
    setTimeout(() => clearInterval(spam), 120);
    const t0 = Date.now();
    const { waitForQuietInput } = await import("../src/helpers");
    await waitForQuietInput(() => Date.now() - last, { minMs: 40, quietMs: 30, maxMs: 500 });
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(140); // ~120ms of input + the quiet window
    expect(took).toBeLessThan(500);
  });

  test("the max caps the wait even under continuous input", async () => {
    const t0 = Date.now();
    const { waitForQuietInput } = await import("../src/helpers");
    await waitForQuietInput(() => 0, { minMs: 40, quietMs: 30, maxMs: 150 });
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(150);
    expect(took).toBeLessThan(320);
  });
});
