/**
 * The shipped systemd unit (deploy/mini-tui-web.service). Agents and the web terminal run `sudo`
 * like the terminal UI does, so the unit must never set NoNewPrivileges=true: with it, the kernel
 * refuses the setuid bit and every `sudo` fails with "the no new privileges flag is set".
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const unit = readFileSync(join(import.meta.dir, "..", "deploy", "mini-tui-web.service"), "utf8");
const service = unit.slice(unit.indexOf("[Service]"), unit.indexOf("[Install]"));
const settings = service
  .split("\n")
  .filter((l) => l.trim() && !l.trimStart().startsWith("#") && l.includes("="))
  .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()] as const);
const get = (key: string) => settings.filter(([k]) => k === key).map(([, v]) => v);

describe("deploy/mini-tui-web.service", () => {
  test("lets sessions use sudo: NoNewPrivileges is off", () => {
    expect(get("NoNewPrivileges")).toEqual(["false"]);
  });
  test("nothing else that blocks setuid binaries is set", () => {
    for (const key of ["RestrictSUIDSGID", "CapabilityBoundingSet", "AmbientCapabilities", "SystemCallFilter", "ProtectSystem", "DynamicUser"]) {
      expect(get(key)).toEqual([]);
    }
  });
  test("runs the server as a user, with the absolute bun path", () => {
    expect(get("User")).toHaveLength(1);
    expect(get("ExecStart")[0]).toMatch(/^\/\S*bun run src\/web\/serve\.ts$/);
  });
});
