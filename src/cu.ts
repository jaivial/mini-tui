import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The cu CLI: `MINITUI_CU_BIN`, else `~/.local/bin/cu`, else `~/.cargo/bin/cu`, else PATH. The
 * same resolution as the agent's `computer_use` tool and its built-in `cu` MCP server.
 * `~/.local/bin/cu` comes first because it is a wrapper that carries its own glibc: the bare
 * cargo binary does not load inside the Docker image (Debian 12, glibc 2.36 vs the 2.39 the
 * binary needs), the wrapper does.
 */
export function cuBin(): string {
  if (process.env.MINITUI_CU_BIN) return process.env.MINITUI_CU_BIN;
  for (const p of [join(homedir(), ".local", "bin", "cu"), join(homedir(), ".cargo", "bin", "cu")]) if (existsSync(p)) return p;
  return "cu";
}
