/**
 * What the web settings panel reads and writes: display settings, provider connections, and the
 * skills and slash commands available to a prompt. Everything reuses the terminal UI's own
 * modules (`settings.ts`, `providers.ts`, `skills.ts`), so a change here is a change there.
 *
 * The one hard rule: an API key never leaves the server. It goes in through `connectProvider`,
 * is stored in providers.json (0600) like `/connect` does, and every read hands back only a
 * masked hint.
 */
import {
  PROVIDERS,
  fetchProviderModels,
  loadConnections,
  saveConnection,
  testProviderModel,
  type ProviderDef,
  type SavedConnection,
} from "../providers";
import { DEFAULT_SETTINGS, OUTPUT_MODES, loadSettings, saveSettings, type OutputMode, type Settings } from "../settings";
import { listSkills } from "../skills";
import { loadLastModel } from "../lastModel";
import { MODELS } from "../models";
import { connectionModelOptions } from "../providers";
import { writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

/** "sk-…a1b2": enough to recognise a key, never enough to use it. */
export function maskKey(key: string): string {
  const k = key.trim();
  if (!k) return "";
  if (k.length <= 8) return "••••";
  return `${k.slice(0, 3)}…${k.slice(-4)}`;
}

export interface ProviderView {
  id: string;
  name: string;
  description: string;
  route: ProviderDef["route"];
  baseUrl: string;
  /** Whether a key is saved for it. */
  connected: boolean;
  keyHint: string;
  models: string[];
  defaultModel: string;
  addedAt: number;
}

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  description: string;
  route: ProviderDef["route"];
  baseUrl: string;
  staticModels: string[];
}

export function providerCatalog(): ProviderCatalogEntry[] {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name, description: p.description, route: p.route, baseUrl: p.baseUrl, staticModels: p.staticModels }));
}

export function connectedProviders(connections: SavedConnection[] = loadConnections()): ProviderView[] {
  return connections.map((c) => ({
    id: c.id,
    name: c.name,
    description: PROVIDERS.find((p) => p.id === c.id)?.description ?? "",
    route: c.route,
    baseUrl: c.baseUrl,
    connected: true,
    keyHint: maskKey(c.key),
    models: c.models,
    defaultModel: c.defaultModel,
    addedAt: c.addedAt,
  }));
}

export type ConnectResult =
  | { ok: true; provider: ProviderView }
  | { ok: false; error: string };

/** The provider's live catalogue merged over the built-in one, so a fresh key sees new models. */
export async function discoverModels(def: ProviderDef, key: string): Promise<string[]> {
  try {
    const live = await fetchProviderModels(def, key);
    return [...new Set([...live, ...def.staticModels])];
  } catch {
    return def.staticModels;
  }
}

/**
 * Validate a key with a real one-token completion, then save it (same steps as `/connect`).
 * Nothing is written unless the test passes, so a typo never replaces a working connection.
 */
export async function connectProvider(
  input: { providerId: string; key: string; model?: string },
  deps: { test?: typeof testProviderModel; discover?: typeof discoverModels; save?: typeof saveConnection } = {},
): Promise<ConnectResult> {
  const def = PROVIDERS.find((p) => p.id === input.providerId);
  if (!def) return { ok: false, error: "unknown provider" };
  const key = input.key.trim();
  if (!key) return { ok: false, error: "an API key is required" };
  if (/\s/.test(key) || key.length > 512) return { ok: false, error: "that does not look like an API key" };

  const models = await (deps.discover ?? discoverModels)(def, key);
  const model = input.model && models.includes(input.model) ? input.model : (models[0] ?? "");
  if (!model) return { ok: false, error: "the provider returned no models" };

  const ok = await (deps.test ?? testProviderModel)(def, `${def.prefix}/${model}`, key);
  if (!ok) return { ok: false, error: `could not reach ${def.prefix}/${model} with that key` };

  const connection: SavedConnection = {
    id: def.id,
    name: def.name,
    route: def.route,
    keyEnv: def.keyEnv,
    extraEnv: def.extraEnv,
    baseUrl: def.baseUrl,
    prefix: def.prefix,
    key,
    models,
    defaultModel: model,
    addedAt: Date.now(),
  };
  (deps.save ?? saveConnection)(connection);
  return { ok: true, provider: connectedProviders([connection])[0]! };
}

/** Forget a connection. Returns false when there was none. */
export function disconnectProvider(id: string, path?: string): boolean {
  const all = loadConnections(path);
  const next = all.filter((c) => c.id !== id);
  if (next.length === all.length) return false;
  writeConnections(next, path);
  return true;
}

function writeConnections(all: SavedConnection[], path?: string): void {
  const target = path ?? process.env.MINITUI_CONNECTIONS_PATH ?? `${process.env.HOME}/.config/mini-tui/providers.json`;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

// ---------------------------------------------------------------- settings

export interface SettingsView extends Settings {
  lastModel: string;
  outputModes: typeof OUTPUT_MODES;
}

export function settingsView(): SettingsView {
  return { ...loadSettings(), lastModel: loadLastModel(), outputModes: OUTPUT_MODES };
}

/** Only known keys with valid values are applied; anything else is ignored, not stored. */
export function patchSettings(patch: Record<string, unknown>): SettingsView {
  const current = loadSettings();
  const next: Settings = { ...current };
  if (typeof patch.outputMode === "string" && OUTPUT_MODES.some((m) => m.value === patch.outputMode)) {
    next.outputMode = patch.outputMode as OutputMode;
  }
  if (typeof patch.theme === "string" && /^[\w-]{1,32}$/.test(patch.theme)) next.theme = patch.theme;
  saveSettings(next);
  return settingsView();
}

// ------------------------------------------------------- commands + skills

export interface CommandInfo {
  name: string;
  /** What to put in the prompt bar / run. */
  insert: string;
  detail: string;
  /** Argument hint shown after the name, e.g. `[id]`. Absent = takes none. */
  args?: string;
  /** `client`: handled by the web app itself; `prompt`: sent to the agent as text. */
  kind: "client" | "prompt";
}

/**
 * The slash commands of the web app. The terminal's own list (`/quit`, `/exit`, `/resume`...) is
 * not copied blindly: each entry here is something the web UI actually does.
 */
export const COMMANDS: CommandInfo[] = [
  { name: "new", insert: "/new", detail: "Start a new chat", kind: "client" },
  { name: "model", insert: "/model", detail: "Switch the model for this chat", args: "[id]", kind: "client" },
  { name: "compact", insert: "/compact", detail: "Summarize the conversation to free context", kind: "client" },
  { name: "connect", insert: "/connect", detail: "Connect a provider with your API key", kind: "client" },
  { name: "settings", insert: "/settings", detail: "Open settings", kind: "client" },
  { name: "skills", insert: "/skills", detail: "Browse skills you can reference with $name", kind: "client" },
  { name: "help", insert: "/help", detail: "Commands and keyboard shortcuts", kind: "client" },
];

export interface SkillInfo {
  name: string;
  description: string;
}

export function skillList(dir?: string): SkillInfo[] {
  return listSkills(dir).map(({ name, description }) => ({ name, description }));
}

/** The default model a fresh chat starts on: the last one picked, else the first in the catalogue. */
export function modelCatalog(): { id: string; name: string; description: string }[] {
  const all = [...MODELS, ...connectionModelOptions(loadConnections())];
  const seen = new Set<string>();
  const out: { id: string; name: string; description: string }[] = [];
  for (const m of all) {
    const id = String(m.value);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: m.name, description: m.description });
  }
  return out;
}

export { DEFAULT_SETTINGS };
