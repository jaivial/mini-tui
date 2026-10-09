/**
 * Agent definitions (`~/.config/mini-tui/agents/<name>.json`, `MINITUI_AGENTS_DIR`), plus the
 * built-in `general` agent the Rust agent ships (agent-rs/agents/general.json). The model creates
 * them with its `agent_define` tool; the web lists them.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentDef {
  name: string;
  description: string;
  when_to_use: string;
  system_prompt: string;
  model: string;
  builtin: boolean;
  created_by?: string;
}

const BUILTIN = new URL("../../agent-rs/agents/general.json", import.meta.url).pathname;

export function agentsDir(): string {
  return process.env.MINITUI_AGENTS_DIR || join(homedir(), ".config", "mini-tui", "agents");
}

function parse(text: string, builtin: boolean): AgentDef | null {
  try {
    const v = JSON.parse(text);
    if (!v?.name || !/^[\w.-]+$/.test(v.name)) return null;
    return {
      name: v.name,
      description: v.description ?? "",
      when_to_use: v.when_to_use ?? "",
      system_prompt: v.system_prompt ?? "",
      model: v.model ?? "",
      builtin,
      created_by: v.created_by,
    };
  } catch {
    return null;
  }
}

export function listAgentDefs(): AgentDef[] {
  const out = new Map<string, AgentDef>();
  if (existsSync(BUILTIN)) {
    const d = parse(readFileSync(BUILTIN, "utf8"), true);
    if (d) out.set(d.name, d);
  }
  const dir = agentsDir();
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      const d = parse(readFileSync(join(dir, f), "utf8"), false);
      if (d) out.set(d.name, d);
    }
  }
  return [...out.values()];
}
