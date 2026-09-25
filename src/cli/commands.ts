/**
 * Scripting subcommands — everything the TUI's slash commands do, from a shell:
 *   sessions [list|show|rm]   the /resume history (`show` prints a transcript)
 *   models                    the /model catalog (+ /connect providers)
 *   model [<id>]              the default model of new sessions (what /model saves)
 *   skills                    the $skill list
 *   settings [<key> <value>]  /settings (output mode, theme)
 */

import { DEFAULT_MODEL } from "../config";
import { loadLastModel, saveLastModel } from "../lastModel";
import { MODELS } from "../models";
import { connectionModelOptions, loadConnections } from "../providers";
import { DEFAULT_DB_PATH, deleteSession, findSession, listAllSessions, openDb, type SessionRecord } from "../sessions";
import { OUTPUT_MODES, loadSettings, saveSettings, type OutputMode } from "../settings";
import { SKILLS_DIR, listSkills } from "../skills";
import type { RunEvent } from "../traj/schema";
import { THEMES } from "../ui/theme";
import type { ModelArgs, ModelsArgs, SessionsArgs, SettingsArgs, SkillsArgs } from "./args";
import { finalAnswer, formatEventText, type HeadlessIO } from "./headless";

type Out = Pick<HeadlessIO, "stdout" | "stderr">;

const json = (out: Out, value: unknown) => out.stdout(`${JSON.stringify(value, null, 2)}\n`);

function sessionSummary(row: SessionRecord) {
  return {
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    model: row.model,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    api_calls: row.api_calls,
    cost_usd: row.cost,
    exit_status: row.exit_status,
  };
}

function when(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

export function sessionsCommand(args: SessionsArgs, out: Out, dbPath: string = DEFAULT_DB_PATH): number {
  const db = openDb(dbPath);
  try {
    if (args.action === "list") {
      const rows = listAllSessions(db, { cwd: args.all ? undefined : (args.cwd ?? process.cwd()), query: args.query, limit: args.limit });
      if (args.json) return json(out, rows.map(sessionSummary)), 0;
      if (!rows.length) {
        out.stderr(args.all ? "no saved sessions\n" : "no saved sessions in this folder (try --all)\n");
        return 0;
      }
      for (const row of rows) {
        const where = args.all ? `  ${row.cwd}` : "";
        out.stdout(`${row.id}  ${when(row.updated_at)}  ${row.exit_status || "-"}  ${row.title}${where}\n`);
      }
      return 0;
    }
    let row: SessionRecord | null;
    try {
      row = findSession(db, args.id!);
    } catch (error) {
      out.stderr(`error: ${(error as Error).message}\n`);
      return 2;
    }
    if (!row) {
      out.stderr(`error: no session ${args.id}\n`);
      return 1;
    }
    if (args.action === "rm") {
      deleteSession(db, row.id);
      if (args.json) json(out, { deleted: row.id });
      else out.stdout(`deleted ${row.id}\n`);
      return 0;
    }
    let events: RunEvent[] = [];
    try {
      events = JSON.parse(row.events_json) as RunEvent[];
    } catch {
      events = [];
    }
    if (args.json) return json(out, { ...sessionSummary(row), result: finalAnswer(events), events }), 0;
    out.stdout(`# ${row.title}\n${row.id} · ${row.model || "default model"} · ${row.cwd} · ${when(row.updated_at)}\n\n`);
    for (const event of events) out.stdout(formatEventText(event));
    return 0;
  } finally {
    db.close();
  }
}

export function modelsCommand(args: ModelsArgs, out: Out): number {
  const current = DEFAULT_MODEL || loadLastModel();
  const rows = [
    ...MODELS.map((option) => ({ id: String(option.value), description: option.description, source: "catalog" })),
    ...connectionModelOptions(loadConnections()).map((option) => ({ id: String(option.value), description: option.description, source: "connected" })),
  ];
  if (args.json) return json(out, rows.map((row) => ({ ...row, default: row.id === current }))), 0;
  for (const row of rows) out.stdout(`${row.id === current ? "*" : " "} ${row.id}${row.description ? `  ${row.description}` : ""}\n`);
  return 0;
}

export function modelCommand(args: ModelArgs, out: Out): number {
  if (args.model) {
    saveLastModel(args.model);
    if (args.json) json(out, { model: args.model });
    else out.stdout(`default model → ${args.model} (new sessions and \`mini-tui -p\` runs)\n`);
    return 0;
  }
  const model = DEFAULT_MODEL || loadLastModel();
  if (args.json) json(out, { model: model || null, source: DEFAULT_MODEL ? "MINITUI_MODEL" : model ? "last-model" : "mini-default" });
  else out.stdout(`${model || "(mini's default)"}\n`);
  return 0;
}

export function skillsCommand(args: SkillsArgs, out: Out): number {
  const skills = listSkills();
  if (args.json) return json(out, skills), 0;
  if (!skills.length) out.stderr(`no skills in ${SKILLS_DIR}\n`);
  for (const skill of skills) out.stdout(`$${skill.name}${skill.description ? `  ${skill.description}` : ""}\n`);
  return 0;
}

export function settingsCommand(args: SettingsArgs, out: Out): number {
  const settings = loadSettings();
  if (!args.key) {
    if (args.json) return json(out, settings), 0;
    out.stdout(`output-mode  ${settings.outputMode}   (${OUTPUT_MODES.map((mode) => mode.value).join(" | ")})\n`);
    out.stdout(`theme        ${settings.theme}   (${THEMES.map((theme) => theme.id).join(" | ")})\n`);
    return 0;
  }
  const key = args.key.replace(/_/g, "-");
  if (key === "output-mode" || key === "outputMode") {
    if (!OUTPUT_MODES.some((mode) => mode.value === args.value)) {
      out.stderr(`error: output-mode must be one of ${OUTPUT_MODES.map((mode) => mode.value).join(", ")}\n`);
      return 2;
    }
    settings.outputMode = args.value as OutputMode;
  } else if (key === "theme") {
    if (!THEMES.some((theme) => theme.id === args.value)) {
      out.stderr(`error: theme must be one of ${THEMES.map((theme) => theme.id).join(", ")}\n`);
      return 2;
    }
    settings.theme = args.value;
  } else {
    out.stderr("error: settings keys are output-mode and theme\n");
    return 2;
  }
  saveSettings(settings);
  if (args.json) json(out, settings);
  else out.stdout(`${key} → ${args.value}\n`);
  return 0;
}
