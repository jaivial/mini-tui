/**
 * A minimal secret vault for the keys that are not a model provider's.
 *
 * `/connect` already stores BYOK provider keys in `providers.json` (0600), which is the right home
 * for a key `mini` itself consumes. Jev is not a mini model: it is an extra decision service this
 * TUI calls itself (the verifier phase), so its key gets its own vault entry instead of a fake
 * provider row that would show up in `/model` as if it could drive a run.
 *
 * Layout: `~/.config/mini-tui/vault.json` (0600), `{"jev-api-key": "…"}`. One flat map of
 * name -> secret is enough: there is exactly one entry today, and a second one should not need a
 * schema migration.
 *
 * Never leaves the machine: every read returns the secret only to the caller that asked for it by
 * name; the UI, the CLI and the HTTP API all go through `maskKeyHint` and never render it.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The one entry this vault has today. */
export const JEV_KEY_NAME = "jev-api-key";

/** Overridable so nothing ever reads the user's real vault by accident (hermetic runs). */
function vaultPath(): string {
  return process.env.MINITUI_VAULT_PATH ?? join(homedir(), ".config", "mini-tui", "vault.json");
}

export function loadVault(path: string = vaultPath()): Record<string, string> {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    // A malformed entry must not poison the rest of the map: keep only name -> non-empty string.
    const out: Record<string, string> = {};
    for (const [name, secret] of Object.entries(data as Record<string, unknown>)) {
      if (typeof secret === "string" && secret.length > 0) out[name] = secret;
    }
    return out;
  } catch {
    return {}; // missing or unreadable vault = no keys, which is the safe default
  }
}

/** Atomic write (tmp + rename) so an interrupted save never truncates the other keys. */
export function writeVault(vault: Record<string, string>, path: string = vaultPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(vault, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort permissions (a filesystem without chmod still gets the 0600 from writeFileSync)
  }
}

export function getSecret(name: string, path?: string): string {
  return loadVault(path)[name] ?? "";
}

export function setSecret(name: string, secret: string, path?: string): void {
  const target = path ?? vaultPath();
  const vault = loadVault(target);
  const trimmed = secret.trim();
  if (trimmed) vault[name] = trimmed;
  else delete vault[name]; // saving an empty key clears it, like clearing a field in the UI
  writeVault(vault, target);
}

export function hasSecret(name: string, path?: string): boolean {
  return getSecret(name, path).length > 0;
}

/** `"ts_…a1b2"`: enough to recognise the key, never enough to use it. */
export function maskKeyHint(secret: string): string {
  const k = secret.trim();
  if (!k) return "";
  if (k.length <= 8) return "••••";
  return `${k.slice(0, 3)}…${k.slice(-4)}`;
}