import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { resolveCommand, resolvePython, runHelperScriptCapture } from "../src/helpers";

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

describe("runHelperScriptCapture", () => {
  test("keeps the failing command's stderr tail and its exit code", async () => {
    const r = await runHelperScriptCapture("ignored", [], {}, ["sh", "-c", "echo 'error: HTTP 401 boom' 1>&2; exit 3"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("error: HTTP 401 boom");
  });

  test("a missing binary reports an error, it never hangs", async () => {
    const r = await runHelperScriptCapture("ignored", [], {}, ["/no/such/binary"]);
    expect(r.code).toBe(-1);
    expect(r.stderr.length).toBeGreaterThan(0);
  });
});

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
