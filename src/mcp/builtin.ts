import { cuBin } from "../cu";
import { spawnBounded } from "../proc/spawnBounded";
import type { ProbeResult } from "./client";

/**
 * mini-tui's built-in MCP server: `cu mcp`, the browser daemon's tools (navigate, snapshot, click,
 * type, act, screenshot...) as `mcp__cu__*`. It is not a record in mcp.json: every run mini-tui
 * spawns turns it on (`MINI_AGENT_CU_MCP=1`, see src/mini/spawn.ts) and the agent starts it over
 * stdio, one `cu mcp` process — one browser page — per run. It cannot be disabled or removed.
 */
export const BUILTIN_CU_ID = "cu";

/** The command line the agent runs, as the UIs show it. */
export const BUILTIN_CU_COMMAND = "cu mcp";

export const BUILTIN_REFUSAL = "cu is built in: every run gets its browser tools, so it cannot be disabled, removed or logged out";

export function isBuiltin(id: string): boolean {
  return id === BUILTIN_CU_ID;
}

/**
 * Prove the built-in works the way a run starts it: `cu mcp`, initialize, tools/list, end of input.
 * The server answers both and exits on the end of its input; nothing reaches the browser. Through
 * the bounded launcher: a deadline that really kills, and a byte budget on what it answers.
 */
export async function probeBuiltin(timeoutMs = 10_000): Promise<ProbeResult> {
  const bin = cuBin();
  const line = (message: object) => `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;
  const run = await spawnBounded([bin, "mcp"], {
    timeoutMs,
    maxBytes: 1024 * 1024,
    stdin:
      line({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mini-tui", version: "probe" } } }) +
      line({ method: "notifications/initialized" }) +
      line({ id: 2, method: "tools/list", params: {} }),
  });
  if (run.reason === "spawn-failed") return { ok: false, error: `cannot run ${bin}` };
  if (run.reason) return { ok: false, error: `${bin} mcp: ${run.reason}` };
  const answers = new Map<unknown, Record<string, unknown>>();
  for (const text of run.stdout.split("\n")) {
    try {
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message && "id" in message) answers.set(message.id, message);
    } catch {
      // not a protocol line (an older cu prints its help here)
    }
  }
  const init = answers.get(1)?.result as { serverInfo?: { version?: string } } | undefined;
  const listed = answers.get(2)?.result as { tools?: { name: string; description?: string }[] } | undefined;
  if (!init || !listed?.tools) return { ok: false, error: `${bin} has no MCP server (cu 1.5.1 or newer is needed)` };
  const version = init.serverInfo?.version;
  return { ok: true, serverName: version ? `cu ${version}` : "cu", tools: listed.tools.map((t) => ({ name: t.name, description: t.description })) };
}
