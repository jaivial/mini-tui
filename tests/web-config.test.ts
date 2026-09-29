/** The web settings/providers layer: secrecy of keys, validation, and what is (not) written. */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "minitui-webcfg-"));
process.env.MINITUI_SETTINGS_PATH = join(dir, "settings.json");
process.env.MINITUI_CONNECTIONS_PATH = join(dir, "providers.json");
process.env.MINITUI_SKILLS_DIR = join(dir, "skills");

const cfg = await import("../src/web/config");
const { loadConnections } = await import("../src/providers");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  for (const f of ["settings.json", "providers.json"]) rmSync(join(dir, f), { force: true });
});

const KEY = "sk-live-abcdef1234567890WXYZ";
const ok = { test: async () => true, discover: async () => ["model-a", "model-b"] };

describe("maskKey", () => {
  test("shows a recognisable tail, never the key", () => {
    const m = cfg.maskKey(KEY);
    expect(m).toBe("sk-…WXYZ");
    expect(m).not.toContain("abcdef");
  });
  test("a short key is fully hidden", () => {
    expect(cfg.maskKey("short")).toBe("••••");
    expect(cfg.maskKey("   ")).toBe("");
  });
});

describe("connectProvider", () => {
  test("a working key is saved 0600 and only a masked hint comes back", async () => {
    const r = await cfg.connectProvider({ providerId: "deepseek", key: KEY }, ok);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(r.ok && r.provider.keyHint).toBe("sk-…WXYZ");
    expect(loadConnections()[0]?.key).toBe(KEY); // stored for the agent, on disk only
    expect((statSync(join(dir, "providers.json")).mode & 0o777).toString(8)).toBe("600");
  });

  test("a key that fails the live test is NOT saved, and an existing connection survives", async () => {
    await cfg.connectProvider({ providerId: "deepseek", key: "sk-good-aaaaaaaaaaaa" }, ok);
    const bad = await cfg.connectProvider({ providerId: "deepseek", key: "sk-typo-bbbbbbbbbbbb" }, { ...ok, test: async () => false });
    expect(bad).toEqual({ ok: false, error: expect.stringContaining("could not reach") });
    expect(loadConnections()).toHaveLength(1);
    expect(loadConnections()[0]?.key).toBe("sk-good-aaaaaaaaaaaa");
  });

  test("the error never echoes the key", async () => {
    const bad = await cfg.connectProvider({ providerId: "deepseek", key: KEY }, { ...ok, test: async () => false });
    expect(JSON.stringify(bad)).not.toContain(KEY);
  });

  test("rejects an unknown provider, an empty key, whitespace and absurd lengths without any network call", async () => {
    let calls = 0;
    const spy = { test: async () => (calls++, true), discover: async () => (calls++, ["m"]) };
    expect(await cfg.connectProvider({ providerId: "nope", key: KEY }, spy)).toMatchObject({ ok: false });
    expect(await cfg.connectProvider({ providerId: "deepseek", key: "  " }, spy)).toMatchObject({ ok: false });
    expect(await cfg.connectProvider({ providerId: "deepseek", key: "has space" }, spy)).toMatchObject({ ok: false });
    expect(await cfg.connectProvider({ providerId: "deepseek", key: "x".repeat(600) }, spy)).toMatchObject({ ok: false });
    expect(calls).toBe(0);
  });

  test("the chosen model must come from the catalogue, else the first one is used", async () => {
    const r = await cfg.connectProvider({ providerId: "deepseek", key: KEY, model: "not-a-model" }, ok);
    expect(r.ok && r.provider.defaultModel).toBe("model-a");
    const r2 = await cfg.connectProvider({ providerId: "deepseek", key: KEY, model: "model-b" }, ok);
    expect(r2.ok && r2.provider.defaultModel).toBe("model-b");
  });

  test("connecting again replaces that provider's entry instead of duplicating it", async () => {
    await cfg.connectProvider({ providerId: "deepseek", key: "sk-one-1111111111111" }, ok);
    await cfg.connectProvider({ providerId: "deepseek", key: "sk-two-2222222222222" }, ok);
    expect(loadConnections()).toHaveLength(1);
    expect(loadConnections()[0]?.key).toBe("sk-two-2222222222222");
  });
});

describe("provider views", () => {
  test("no view ever contains a key field", async () => {
    await cfg.connectProvider({ providerId: "deepseek", key: KEY }, ok);
    const views = cfg.connectedProviders();
    expect(views).toHaveLength(1);
    expect("key" in views[0]!).toBe(false);
    expect(JSON.stringify(views)).not.toContain(KEY);
  });
  test("the catalogue lists every provider without secrets", () => {
    const cat = cfg.providerCatalog();
    expect(cat.length).toBeGreaterThanOrEqual(10);
    expect(JSON.stringify(cat)).not.toMatch(/KEY_?ENV|_API_KEY/);
  });
  test("disconnect removes only that provider, and reports a miss", async () => {
    await cfg.connectProvider({ providerId: "deepseek", key: KEY }, ok);
    await cfg.connectProvider({ providerId: "zai", key: "sk-zai-3333333333333" }, ok);
    expect(cfg.disconnectProvider("deepseek")).toBe(true);
    expect(loadConnections().map((c) => c.id)).toEqual(["zai"]);
    expect(cfg.disconnectProvider("deepseek")).toBe(false);
    expect((statSync(join(dir, "providers.json")).mode & 0o777).toString(8)).toBe("600");
  });
});

describe("settings", () => {
  test("defaults, then a valid patch persists", () => {
    expect(cfg.settingsView().outputMode).toBe("collapsed");
    cfg.patchSettings({ outputMode: "expanded" });
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).outputMode).toBe("expanded");
  });
  test("unknown keys and invalid values are ignored, not stored", () => {
    cfg.patchSettings({ outputMode: "expanded" });
    const v = cfg.patchSettings({ outputMode: "bogus", theme: "../../etc", evil: "x", __proto__: { polluted: 1 } });
    expect(v.outputMode).toBe("expanded");
    expect(v.theme).toBe("shadcn");
    const stored = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(Object.keys(stored).sort()).toEqual(["outputMode", "theme"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  test("a broken settings file falls back to defaults", () => {
    writeFileSync(join(dir, "settings.json"), "{not json");
    expect(cfg.settingsView().outputMode).toBe("collapsed");
  });
});

describe("commands and skills", () => {
  test("every command is unique and slash-prefixed", () => {
    const names = cfg.COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of cfg.COMMANDS) expect(c.insert).toBe(`/${c.name}`);
  });
  test("skills come from the configured folder, name + description only", () => {
    expect(existsSync(process.env.MINITUI_SKILLS_DIR!)).toBe(false);
    expect(cfg.skillList(join(dir, "nope"))).toEqual([]);
  });
});
