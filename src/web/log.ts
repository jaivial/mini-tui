/**
 * Structured debug logging for the web server and the agent runs it spawns.
 *
 * One line per event, `k=v` fields, to stderr: journald (`journalctl -u mini-tui-web -f`)
 * is the debugger. On so the orchestration path (session -> spawn -> subagents -> plan
 * transitions -> exit) can be followed end to end; `MINITUI_WEB_LOG=0` silences it.
 * Only the web process logs: the terminal UI shares these modules and must not get
 * stderr noise, so every line is gated on MINITUI_WEB=1, which serve.ts sets at boot.
 */

const TAG = "mini-tui-web";

function webProcess(): boolean {
  if (process.env.MINITUI_WEB === "1") return true;
  // Imported before serve.ts had a chance to set it? Respect the explicit switch anyway.
  return process.env.MINITUI_WEB_LOG === "1";
}

function enabled(): boolean {
  return webProcess() && process.env.MINITUI_WEB_LOG !== "0";
}

function value(v: unknown): string {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  let s = String(v);
  if (s.length > 200) s = `${s.slice(0, 197)}...`;
  return /[\s="]/.test(s) ? JSON.stringify(s) : s;
}

function line(event: string, fields: Record<string, unknown>): string {
  const parts = Object.entries(fields)
    .map(([k, v]) => [k, value(v)] as const)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${v}`);
  return `[${TAG}] ${event}${parts.length ? " " + parts.join(" ") : ""}`;
}

/** One structured event line (stderr, so StandardError=journal picks it up). */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  if (!enabled()) return;
  console.error(line(event, fields));
}

/** An event that failed; the error message becomes a field. */
export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  if (!enabled()) return;
  const msg = error instanceof Error ? error.message : String(error);
  console.error(line(event, { ...fields, error: msg }));
}
