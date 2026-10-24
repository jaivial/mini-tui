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
  testProviderModelDetail,
  type ProviderDef,
  type SavedConnection,
} from "../providers";
import { DEFAULT_SETTINGS, OUTPUT_MODES, loadSettings, saveSettings, type OutputMode, type Settings } from "../settings";
import { gatewayServes, loadCliproxyCatalogSync, type CliproxyCatalog } from "../cliproxyCatalog";
import { listSkills } from "../skills";
import { loadLastModel } from "../lastModel";
import { MODELS } from "../models";
import { connectionModelOptions } from "../providers";
import { writeFileSync, mkdirSync, renameSync } from "node:fs";
import { clampConcurrency, MAX_CONCURRENCY } from "./workQueue";
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

/** The provider's live catalogue merged over the built-in one, so a fresh key sees new models.
 *  The list failure is kept too: when every probe then fails, "the model list at <url> said
 *  HTTP 401" is the difference between a mystery and a diagnosis. */
export async function discoverModelsWithDetail(def: ProviderDef, key: string): Promise<{ models: string[]; listError?: string }> {
  try {
    const live = await fetchProviderModels(def, key);
    return { models: [...new Set([...live, ...def.staticModels])] };
  } catch (error) {
    return { models: def.staticModels, listError: `${def.baseUrl.replace(/\/$/, "")}/models said ${(error as Error).message}` };
  }
}

/** The provider's live catalogue merged over the built-in one (see discoverModelsWithDetail). */
export async function discoverModels(def: ProviderDef, key: string): Promise<string[]> {
  return (await discoverModelsWithDetail(def, key)).models;
}

/** Model ids that are almost never chat-completion models (speech, embedding, realtime…). */
const NON_CHAT_MODEL = /(^|[-_.])(asr|tts|stt|whisper|audio|speech|voice|embed|embedding|rerank|moderation|realtime)([-_.]|$)/i;

/**
 * The models a new key is validated against, in catalogue order.
 *
 * THE DEFECT THIS EXISTS TO FIX (measured on the deployed web app): the live /models
 * list is sorted alphabetically and mixes in everything the endpoint serves — xiaomi's
 * lists `mimo-v2.5-asr` and three TTS models before `mimo-v2.6-flash` — and the probe
 * used to test `models[0]` ALONE. An ASR model answers a chat completion with
 * `400 Param Incorrect`, so pasting a CORRECT key was rejected with
 * `could not reach xiaomi/mimo-v2.5-asr with that key` (the same class of failure as
 * kimi-coding and any provider whose first id is speech, embedding or plan-gated).
 *
 * Candidates are the chat-looking ids, catalogue order preserved; a list with no
 * chat-looking id at all is kept whole (nothing may become unselectable by filtering).
 * Everything stays in the saved model list either way — this only picks what gets probed.
 */
export function connectCandidates(models: string[]): string[] {
  const chatLike = models.filter((m) => !NON_CHAT_MODEL.test(m));
  return chatLike.length ? chatLike : models;
}

/** How many catalogue models a connect may probe before it condemns the key.
 *  Failures are fast (a 4xx from the endpoint); the cap bounds a provider that
 *  answers slowly, so a bad key still fails in seconds, not minutes. */
const CONNECT_PROBE_ATTEMPTS = 5;

/**
 * Validate a key with a real one-token completion, then save it (same steps as `/connect`).
 * Nothing is written unless the test passes, so a typo never replaces a working connection.
 *
 * A key is never condemned by ONE model: the catalogue lists everything the provider's
 * /models serves (speech, embedding and plan-gated ids included), so the probe walks the
 * candidate models until one answers. The first model that answers becomes the default.
 */
export async function connectProvider(
  input: { providerId: string; key: string; model?: string },
  deps: {
    test?: typeof testProviderModel;
    discover?: typeof discoverModels;
    save?: typeof saveConnection;
    probe?: (def: ProviderDef, modelName: string, key: string) => Promise<{ ok: boolean; detail?: string }>;
    discoverDetailed?: typeof discoverModelsWithDetail;
  } = {},
): Promise<ConnectResult> {
  const def = PROVIDERS.find((p) => p.id === input.providerId);
  if (!def) return { ok: false, error: "unknown provider" };
  const key = input.key.trim();
  if (!key) return { ok: false, error: "an API key is required" };
  if (/\s/.test(key) || key.length > 512) return { ok: false, error: "that does not look like an API key" };

  const { models, listError } = deps.discover
    ? { models: await deps.discover(def, key), listError: undefined as string | undefined }
    : await (deps.discoverDetailed ?? discoverModelsWithDetail)(def, key);
  // An explicit choice must pass as given (or, if it is not in the catalogue at all,
  // fall back to the candidates) — it is never silently replaced by another model.
  const candidates = input.model && models.includes(input.model) ? [input.model] : connectCandidates(models);
  if (!candidates.length) return { ok: false, error: "the provider returned no models" };

  const probe: (def: ProviderDef, modelName: string, key: string) => Promise<{ ok: boolean; detail?: string }> =
    deps.probe ?? (deps.test ? async (d, m, k) => ({ ok: await deps.test!(d, m, k) }) : testProviderModelDetail);
  const probed: string[] = [];
  let firstDetail: string | undefined;
  for (const candidate of candidates.slice(0, CONNECT_PROBE_ATTEMPTS)) {
    probed.push(candidate);
    const verdict = await probe(def, `${def.prefix}/${candidate}`, key);
    if (!verdict.ok) {
      firstDetail ??= verdict.detail;
      continue;
    }
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
      defaultModel: candidate,
      addedAt: Date.now(),
    };
    (deps.save ?? saveConnection)(connection);
    return { ok: true, provider: connectedProviders([connection])[0]! };
  }
  const named = probed.map((m) => `${def.prefix}/${m}`).join(", ");
  // The provider's own words when it gave any: "could not reach …" alone cannot distinguish
  // an expired key from a wrong model id from a missing agent binary — that mystery is what
  // kept the kimi-coding report unsolvable.
  const why = [firstDetail, listError && `model list: ${listError}`].filter(Boolean).join("; ");
  return { ok: false, error: `could not reach ${probed.length === 1 ? named : `${def.prefix} (tried ${named})`} with that key${why ? ` — ${why}` : ""}` };
}

/**
 * Ask the provider what models this connection's base URL and key can use right now, and store that
 * list. Only the live answer is kept (no built-in models mixed in), so the panel shows exactly what
 * the endpoint serves. A failure leaves the saved list untouched.
 */
export async function refetchProviderModels(
  id: string,
  deps: { fetch?: typeof fetchProviderModels; load?: typeof loadConnections; save?: typeof saveConnection } = {},
): Promise<ConnectResult | { ok: false; error: string; notFound: true }> {
  const connection = (deps.load ?? loadConnections)().find((c) => c.id === id);
  if (!connection) return { ok: false, error: "not connected", notFound: true };
  const def = PROVIDERS.find((p) => p.id === id);
  if (!def) return { ok: false, error: "unknown provider" };
  let models: string[];
  try {
    models = await (deps.fetch ?? fetchProviderModels)({ ...def, baseUrl: connection.baseUrl }, connection.key);
  } catch (error) {
    return { ok: false, error: `could not list models at ${connection.baseUrl}: ${(error as Error).message}` };
  }
  if (!models.length) return { ok: false, error: `${connection.baseUrl} returned no models` };
  // Same rule as connect: a vanished default falls back to the first CHAT model, so a
  // refetch can never hand the default slot to an ASR/TTS/embedding id.
  const next: SavedConnection = { ...connection, models, defaultModel: models.includes(connection.defaultModel) ? connection.defaultModel : connectCandidates(models)[0]! };
  (deps.save ?? saveConnection)(next);
  return { ok: true, provider: connectedProviders([next])[0]! };
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

export interface LiveScreenView {
  enabled: boolean;
  /** The one origin the viewer is served from; the browser compares the URL against it. */
  origin: string | null;
  viewerUrl: string | null;
  loginUrl: string | null;
  /** The full viewer with controls. Opened in its own tab, never framed. */
  controlUrl: string | null;
}

/**
 * The live cu screen, read-only for the browser. OFF unless the operator sets
 * MINI_LIVE_SCREEN=1, MINI_LIVE_SCREEN_ORIGIN (one https origin) and
 * MINI_LIVE_SCREEN_VIEWER_URL (that origin + /vault/live2/view, the read-only page, nothing else). A
 * client cannot patch any of it. Any mismatch turns the feature off.
 */
export function liveScreenView(env: Record<string, string | undefined> = process.env): LiveScreenView {
  const off: LiveScreenView = { enabled: false, origin: null, viewerUrl: null, loginUrl: null, controlUrl: null };
  if (env.MINI_LIVE_SCREEN !== "1") return off;
  try {
    const origin = new URL(env.MINI_LIVE_SCREEN_ORIGIN ?? "");
    const viewer = new URL(env.MINI_LIVE_SCREEN_VIEWER_URL ?? "");
    if (origin.protocol !== "https:" || origin.origin !== (env.MINI_LIVE_SCREEN_ORIGIN ?? "").replace(/\/$/, "")) return off;
    if (viewer.origin !== origin.origin || viewer.pathname !== "/vault/live2/view" || viewer.search || viewer.hash) return off;
    if (viewer.username || viewer.password) return off;
    return { enabled: true, origin: origin.origin, viewerUrl: viewer.href, loginUrl: `${origin.origin}/vault`, controlUrl: `${origin.origin}/vault/live2` };
  } catch {
    return off;
  }
}

export interface SettingsView extends Settings {
  lastModel: string;
  outputModes: typeof OUTPUT_MODES;
  liveScreen: LiveScreenView;
  maxQueueConcurrency: number;
}

export function settingsView(): SettingsView {
  const settings = loadSettings();
  return { ...settings, queueConcurrency: clampConcurrency(settings.queueConcurrency), maxQueueConcurrency: MAX_CONCURRENCY, lastModel: loadLastModel(), outputModes: OUTPUT_MODES, liveScreen: liveScreenView() };
}

/** Only known keys with valid values are applied; anything else is ignored, not stored. */
export function patchSettings(patch: Record<string, unknown>): SettingsView {
  const current = loadSettings();
  const next: Settings = { ...current };
  if (typeof patch.outputMode === "string" && OUTPUT_MODES.some((m) => m.value === patch.outputMode)) {
    next.outputMode = patch.outputMode as OutputMode;
  }
  if (typeof patch.theme === "string" && /^[\w-]{1,32}$/.test(patch.theme)) next.theme = patch.theme;
  // The two Jev toggles, independently: a boolean is taken as given, anything else is ignored so a
  // stray string cannot switch Jev on.
  if (typeof patch.jevEnabled === "boolean") next.jevEnabled = patch.jevEnabled;
  if (typeof patch.jevVerifierEnabled === "boolean") next.jevVerifierEnabled = patch.jevVerifierEnabled;
  // v6-C: the model router. OFF is the default and the documented behaviour — with
  // it off the router is not consulted at all, so the manual selector is the only
  // thing that picks a model. Only an explicit boolean flips it.
  if (typeof patch.modelRouterEnabled === "boolean") next.modelRouterEnabled = patch.modelRouterEnabled;
  if (typeof patch.queueConcurrency === "number" && Number.isFinite(patch.queueConcurrency)) next.queueConcurrency = clampConcurrency(patch.queueConcurrency);
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
  { name: "resume", insert: "/resume", detail: "Reopen a saved session and continue it", kind: "client" },
  { name: "split", insert: "/split", detail: "Open a new pane beside this one (down: below it)", args: "[right|down]", kind: "client" },
  { name: "notes", insert: "/notes", detail: "Open this session's notes", kind: "client" },
  { name: "terminal", insert: "/terminal", detail: "Open a terminal in this session's folder", kind: "client" },
  { name: "compact", insert: "/compact", detail: "Summarize the conversation to free context", kind: "client" },
  { name: "subagents", insert: "/subagents", detail: "List the subagents this session started, or open one", args: "[name]", kind: "client" },
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

/**
 * The default model a fresh chat starts on: the last one picked, else the first in the catalogue.
 *
 * `cliproxy/` ids are checked against the gateway's own `/v1/models` first: cli-proxy drops a model
 * from that list when the subscription behind it signs out, and a run then dies with
 * `auth_unavailable` â which names the gateway's internals, not the cause. Marking it here puts the
 * reason in the picker, before the user commits a run to it. A gateway that cannot be reached is
 * left unannotated: the run may still work (another host, a slow start) and the picker must not
 * block one on a probe it cannot trust.
 */
export function modelCatalog(): { id: string; name: string; description: string }[] {
  const all = [...MODELS, ...connectionModelOptions(loadConnections())];
  const seen = new Set<string>();
  const out: { id: string; name: string; description: string }[] = [];
  let cliproxy: CliproxyCatalog | null = null;
  for (const m of all) {
    const id = String(m.value);
    if (seen.has(id)) continue;
    seen.add(id);
    let description = m.description;
    if (id.startsWith("cliproxy/")) {
      cliproxy ??= loadCliproxyCatalogSync();
      if (gatewayServes(cliproxy, id) === false) {
        description = `${description} — NOT SERVED by cli-proxy (subscription signed out)`;
      }
    }
    out.push({ id, name: m.name, description });
  }
  return out;
}

export { DEFAULT_SETTINGS };
