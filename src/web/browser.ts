/**
 * The browser panel's server side: what the persistent `cu` daemon (the agents' browser) is
 * showing, and a way to show it in the web app.
 *
 * The daemon keeps its bearer token in `~/.cu/daemon/server.json`. It never reaches a page:
 * the web server reads the tab list and takes screenshots with it, and relays the daemon's
 * live frame stream over its own (same-origin) websocket, frame for frame.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cuBin } from "../cu";
import { log } from "./log";

export interface CuTab {
  id: string;
  url: string;
  title: string;
  default: boolean;
}

interface Daemon {
  port: number;
  token: string;
}

export function daemonInfo(): Daemon | null {
  const path = process.env.MINITUI_CU_DAEMON_FILE ?? join(homedir(), ".cu", "daemon", "server.json");
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8")) as { port?: unknown; token?: unknown };
    if (typeof data.port !== "number" || typeof data.token !== "string" || !data.token) return null;
    return { port: data.port, token: data.token };
  } catch {
    return null;
  }
}

/** The cu CLI (see src/cu.ts: shared with the built-in `cu` MCP server). */
export { cuBin };

/** The daemon's open tabs (minus chrome:// pages), or null when no daemon runs. */
export async function listTabs(): Promise<CuTab[] | null> {
  const d = daemonInfo();
  if (!d) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${d.port}/v1/vault/live/tabs`, { headers: { authorization: `Bearer ${d.token}` }, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { tabs?: Array<{ id: string; url: string; title: string; default?: boolean }> };
    return (data.tabs ?? [])
      .filter((t) => typeof t.id === "string" && !String(t.url ?? "").startsWith("chrome"))
      .map((t) => ({ id: t.id, url: String(t.url ?? ""), title: String(t.title ?? ""), default: !!t.default }));
  } catch {
    return null;
  }
}

const TAB_ID = /^[A-Za-z0-9_-]{4,80}$/;

/** A PNG of one tab, through the cu CLI (which talks to the same daemon). */
export async function screenshot(tab: string): Promise<Uint8Array | null> {
  if (!TAB_ID.test(tab)) return null;
  const file = join(process.env.TMPDIR ?? "/tmp", `mini-shot-${process.pid}-${Date.now()}.png`);
  try {
    // `cu shot` talks to the running daemon over its socket: no display of its own is needed.
    const proc = Bun.spawn({ cmd: [cuBin(), "shot", file, "--png", "--tab", tab], stdout: "pipe", stderr: "pipe", env: process.env });
    const code = await Promise.race([proc.exited, new Promise<number>((r) => setTimeout(() => (proc.kill(), r(-1)), 15_000))]);
    if (code !== 0) return null;
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    return bytes.length ? bytes : null;
  } catch (error) {
    log("browser.shot", { tab, error: (error as Error).message });
    return null;
  } finally {
    try {
      unlinkSync(file);
    } catch {
      // never written, or swept with /tmp
    }
  }
}

export type BrowserInput =
  | { do: "tap"; x: number; y: number }
  | { do: "scroll"; x: number; y: number; dx: number; dy: number }
  | { do: "type"; text: string }
  | { do: "press"; name: "Enter" | "Backspace" | "Tab" | "Escape" };

/** The human's input on a tab (the panel, with control taken): tap, scroll, type, press. */
export async function input(tab: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const d = daemonInfo();
  if (!d || !TAB_ID.test(tab)) return { ok: false, error: "no browser daemon" };
  const b = body as Partial<BrowserInput> & Record<string, unknown>;
  const frac = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  let clean: BrowserInput;
  if (b.do === "tap" && frac(b.x) && frac(b.y)) clean = { do: "tap", x: b.x as number, y: b.y as number };
  else if (b.do === "scroll" && frac(b.x) && frac(b.y) && typeof b.dx === "number" && typeof b.dy === "number") clean = { do: "scroll", x: b.x as number, y: b.y as number, dx: Math.max(-4000, Math.min(4000, b.dx)), dy: Math.max(-4000, Math.min(4000, b.dy)) };
  else if (b.do === "type" && typeof b.text === "string" && b.text.length <= 4000) clean = { do: "type", text: b.text };
  else if (b.do === "press" && (b.name === "Enter" || b.name === "Backspace" || b.name === "Tab" || b.name === "Escape")) clean = { do: "press", name: b.name };
  else return { ok: false, error: "input must be tap {x,y}, scroll {x,y,dx,dy}, type {text} or press {name}" };
  try {
    const res = await fetch(`http://127.0.0.1:${d.port}/v1/vault/live/input?tab=${encodeURIComponent(tab)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
      body: JSON.stringify(clean),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return data.ok ? { ok: true } : { ok: false, error: data.error ?? `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Relay the daemon's live stream for one tab to a browser socket. Frames (binary JPEG with a
 * 9-byte header) go down unchanged; the viewer's `ack`/`ping` go up. Control messages (mouse,
 * keys) are relayed too when `control` is set: that is how a human solves a captcha or scans a
 * QR in the agent's browser from the panel.
 */
export function relayStream(tab: string, control: boolean, down: { send(data: string | Uint8Array): void; close(code?: number, reason?: string): void }): { up(data: string): void; close(): void } | null {
  const d = daemonInfo();
  if (!d || !TAB_ID.test(tab)) return null;
  const mode = control ? "" : "mode=view&";
  const upstream = new WebSocket(`ws://127.0.0.1:${d.port}/v1/vault/live/stream?${mode}tab=${encodeURIComponent(tab)}`, { headers: { authorization: `Bearer ${d.token}` } } as unknown as string[]);
  upstream.binaryType = "arraybuffer";
  let open = false;
  const pending: string[] = [];
  upstream.onopen = () => {
    open = true;
    for (const m of pending.splice(0)) upstream.send(m);
  };
  upstream.onmessage = (ev) => {
    if (typeof ev.data === "string") down.send(ev.data);
    else down.send(new Uint8Array(ev.data as ArrayBuffer));
  };
  upstream.onclose = (ev) => down.close(1000, ev.reason || "upstream closed");
  upstream.onerror = () => down.close(1011, "upstream error");
  return {
    up(data: string) {
      // Only the viewer protocol's own messages travel up. Input does not go over the stream:
      // this daemon applies it through `POST /v1/vault/live/input` (tap, scroll, type, press),
      // which `input()` below speaks; the stream carries frames, acks and the control handshake.
      let m: { t?: string };
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
      const handshake = m.t === "take" || m.t === "release";
      if (handshake && !control) return;
      if (!handshake && m.t !== "ack" && m.t !== "ping") return;
      if (open) upstream.send(data);
      else pending.push(data);
    },
    close() {
      try {
        upstream.close();
      } catch {
        // already closed
      }
    },
  };
}
