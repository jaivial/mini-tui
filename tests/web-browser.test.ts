import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cuBin, daemonInfo, input, listTabs, screenshot } from "../src/web/browser";

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("the browser panel's server side", () => {
  test("the cu binary: MINITUI_CU_BIN wins, else the wrapper under ~/.local/bin", () => {
    process.env.MINITUI_CU_BIN = "/x/cu";
    expect(cuBin()).toBe("/x/cu");
    delete process.env.MINITUI_CU_BIN;
    expect(cuBin()).toMatch(/\/cu$/);
  });

  test("no daemon file: tabs are null, a screenshot is null, input says so — never a throw", async () => {
    process.env.MINITUI_CU_DAEMON_FILE = join(mkdtempSync(join(tmpdir(), "cu-")), "missing.json");
    expect(daemonInfo()).toBeNull();
    expect(await listTabs()).toBeNull();
    expect((await input("ABCDEF", { do: "tap", x: 0.5, y: 0.5 })).ok).toBe(false);
  });

  test("a malformed daemon file is no daemon", () => {
    const f = join(mkdtempSync(join(tmpdir(), "cu-")), "server.json");
    writeFileSync(f, JSON.stringify({ port: "8810", token: 5 }));
    process.env.MINITUI_CU_DAEMON_FILE = f;
    expect(daemonInfo()).toBeNull();
  });

  test("tab ids are validated before anything runs", async () => {
    process.env.MINITUI_CU_BIN = "/bin/false";
    expect(await screenshot("../../etc")).toBeNull();
    expect(await screenshot("a b")).toBeNull();
    expect((await input("x", { do: "tap", x: 0.5, y: 0.5 })).ok).toBe(false);
  });
});
