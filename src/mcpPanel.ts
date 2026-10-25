import type { LoginView, McpPreset, McpServerView } from "./mcp/index";

/**
 * The `/mcp` panel of the terminal UI, as data. App.tsx owns the side effects (store writes, the
 * login flow, the clipboard, the browser); this file is the screen it is on.
 *
 *   list    installed servers + "add a server"   ↑↓ move · Enter open · a add · d remove · Esc close
 *   add     presets + "custom URL"               ↑↓ · Enter install
 *   url     typing a custom URL                  Enter add · Esc back
 *   login   the authorization link, waiting      c copy · o open · p paste the redirect · Esc cancel
 *   done / error
 */
export type McpStep =
  | { kind: "list"; index: number; busy?: string; note?: string }
  | { kind: "add"; index: number; query: string }
  | { kind: "url"; value: string; error?: string }
  | { kind: "login"; login: LoginView; copied?: boolean; opened?: string; pasting?: string; pasteError?: string }
  | { kind: "done"; name: string; tools: number }
  | { kind: "error"; message: string; serverId?: string };

export function filterPresets(presets: McpPreset[], query: string, installed: string[]): McpPreset[] {
  const q = query.trim().toLowerCase();
  return presets.filter((p) => !installed.includes(p.id) && (!q || `${p.name} ${p.description} ${p.id}`.toLowerCase().includes(q)));
}

/** Rows of the add screen: matching presets, then "custom URL". */
export function addRows(presets: McpPreset[], query: string, installed: string[]): Array<McpPreset | "custom"> {
  return [...filterPresets(presets, query, installed), "custom"];
}

export const STATE_LABEL: Record<McpServerView["state"], string> = {
  connected: "connected",
  "needs-login": "needs login",
  expired: "login expired",
  disabled: "disabled",
  ready: "ready",
};

export function remaining(expiresAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
