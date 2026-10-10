/**
 * Scripting subcommands — everything the TUI's slash commands do, from a shell:
 *   sessions [list|show|rm]   the /resume history (`show` prints a transcript)
 *   models                    the /model catalog (+ /connect providers)
 *   model [<id>]              the default model of new sessions (what /model saves)
 *   skills                    the $skill list
 *   settings [<key> <value>]  /settings (output mode, theme, jev, jev-verifier, jev-key)
 */

import { DEFAULT_MODEL } from "../config";
import { defaultDoctorModel, formatDoctor, runDoctor } from "../cliproxyDoctor";
import { loadLastModel, saveLastModel } from "../lastModel";
import { MODELS } from "../models";
import { connectionModelOptions, loadConnections } from "../providers";
import { DEFAULT_DB_PATH, TASK_LIMITS, deleteSession, deleteTask, findLiveRunByControl, findSession, getTask, listAllSessions, openDb, saveTask, type SessionRecord, type SessionTask } from "../sessions";
import { OUTPUT_MODES, loadSettings, saveSettings, type OutputMode } from "../settings";
import { JEV_KEY_NAME, getSecret, maskKeyHint, setSecret } from "../jev/vault";
import { resolveJevKey } from "../jev/client";
import { jevModels } from "../jev/client";
import { SKILLS_DIR, listSkills } from "../skills";
import type { RunEvent } from "../traj/schema";
import { THEMES } from "../ui/theme";
import type { DoctorArgs, JevArgs, ModelArgs, ModelsArgs, SessionsArgs, SettingsArgs, SkillsArgs, TasksArgs } from "./args";
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

/** A card's to-dos as one line per bucket, for `tasks show`. */
function todoLines(task: SessionTask): string[] {
  const rows: string[] = [];
  for (const [key, label] of [["done", "done   "], ["pending", "pending"], ["left", "left   "]] as const) {
    for (const [i, item] of task.todos[key].entries()) rows.push(`  ${i ? "       " : label}  ${item}`);
    if (!task.todos[key].length) rows.push(`  ${label}  -`);
  }
  return rows;
}

/**
 * The session a `tasks` call is filling a card for. Named by `--session`, else the session the
 * calling agent runs in: `$MINITUI_SESSION_ID` when its spawner set one, else the session that
 * registered the control file every agent has in `$MSWEA_CONTROL_FILE`.
 */
export function resolveTaskSession(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env, byControl?: (control: string) => string | null): string | null {
  const named = explicit?.trim() || env.MINITUI_SESSION_ID?.trim();
  if (named) return named;
  const control = env.MSWEA_CONTROL_FILE?.trim();
  if (control && byControl) return byControl(control);
  return null;
}

/** Keep a card inside its limits with one clear error, instead of silently trimming the agent's words. */
function taskTooBig(args: TasksArgs): string | null {
  const fields: [string, string, number][] = [
    ["--title", args.title ?? "", TASK_LIMITS.title],
    ["--description", args.description ?? "", TASK_LIMITS.description],
  ];
  for (const key of ["done", "pending", "left"] as const) for (const item of args[key]) fields.push([`--${key} item`, item, TASK_LIMITS.item]);
  for (const [name, value, max] of fields) if (value.length > max) return `${name} is longer than ${max} characters`;
  for (const key of ["done", "pending", "left"] as const) if (args[key].length > TASK_LIMITS.items) return `more than ${TASK_LIMITS.items} --${key} items`;
  return null;
}

/**
 * `mini-tui tasks set|show|clear`: the task card every agent fills for its session — a title, an
 * AI-written description of what was done, and the to-dos as done / pending / what is left. `set`
 * replaces the whole card. The web app shows the cards live (over its hub socket).
 */
export function tasksCommand(args: TasksArgs, out: Out, dbPath: string = DEFAULT_DB_PATH): number {
  const db = openDb(dbPath);
  try {
    const id = resolveTaskSession(args.session, process.env, (control) => findLiveRunByControl(db, control)?.session_id ?? null);
    if (!id) {
      out.stderr("error: cannot tell which session this card is for: pass --session <id>, or run inside a mini-tui session\n");
      return 2;
    }
    if (args.action === "set") {
      const tooBig = taskTooBig(args);
      if (tooBig) {
        out.stderr(`error: ${tooBig}\n`);
        return 2;
      }
      if (!args.title?.trim() && !args.description?.trim() && !args.done.length && !args.pending.length && !args.left.length) {
        out.stderr("error: a task card needs something: --title, --description, --done, --pending or --left\n");
        return 2;
      }
      const task = saveTask(db, id, { title: args.title ?? "", description: args.description ?? "", todos: { done: args.done, pending: args.pending, left: args.left } });
      if (args.json) return json(out, task), 0;
      out.stdout(`task card saved for ${id}: ${task.title || "(no title)"} (${task.todos.done.length} done, ${task.todos.pending.length} pending, ${task.todos.left.length} left)\n`);
      return 0;
    }
    if (args.action === "clear") {
      deleteTask(db, id);
      if (args.json) return json(out, { id, cleared: true }), 0;
      out.stdout(`task card cleared for ${id}\n`);
      return 0;
    }
    const task = getTask(db, id);
    if (args.json) return json(out, task), 0;
    if (!task.updatedAt) {
      out.stdout(`no task card for ${id}\n`);
      return 0;
    }
    out.stdout(`${id}  ${task.title || "(no title)"}\n`);
    if (task.description) out.stdout(`${task.description}\n`);
    out.stdout(`${todoLines(task).join("\n")}\n`);
    return 0;
  } finally {
    db.close();
  }
}

export function settingsCommand(args: SettingsArgs, out: Out): number {
  const settings = loadSettings();
  if (!args.key) {
    if (args.json) return json(out, settings), 0;
    out.stdout(`output-mode  ${settings.outputMode}   (${OUTPUT_MODES.map((mode) => mode.value).join(" | ")})\n`);
    out.stdout(`theme        ${settings.theme}   (${THEMES.map((theme) => theme.id).join(" | ")})\n`);
    out.stdout(`jev          ${settings.jevEnabled ? "on" : "off"}   (TypeSafe System One decisions)\n`);
    out.stdout(`jev-verifier ${settings.jevVerifierEnabled ? "on" : "off"}   (LLM+Jev phase after each finished turn)\n`);
    const saved = getSecret(JEV_KEY_NAME);
    const auth = resolveJevKey();
    out.stdout(
      `jev key      ${saved ? `${maskKeyHint(saved)} (vault)` : "not in the vault"}${auth.key ? `   (in force: ${auth.source})` : "   (none: the phase will degrade)"}\n`,
    );
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
  } else if (key === "jev" || key === "jev-verifier") {
    // Both toggles are boolean and independent: neither one reads or writes the other.
    const value = args.value === "on" || args.value === "true" || args.value === "1";
    if (args.value !== undefined && !["on", "off", "true", "false", "1", "0"].includes(args.value)) {
      out.stderr(`error: ${key} must be on or off\n`);
      return 2;
    }
    if (key === "jev") settings.jevEnabled = value;
    else settings.jevVerifierEnabled = value;
  } else if (key === "jev-key") {
    // Writing the key is a separate verb from flipping a toggle: a turn-on with no key must not
    // silently ship without one, and turning jev off must not delete the stored key.
    setSecret(JEV_KEY_NAME, args.value ?? "");
    out.stdout(args.value ? "jev-api-key saved\n" : "jev-api-key cleared\n");
    return 0;
  } else {
    out.stderr("error: settings keys are output-mode, theme, jev, jev-verifier and jev-key\n");
    return 2;
  }
  saveSettings(settings);
  if (args.json) json(out, settings);
  else out.stdout(`${key} → ${args.value}\n`);
  return 0;
}

/**
 * `mini-tui jev check` — is the Jev key usable, and which model actually answers?
 *
 * This is the same `GET /v1/models` the /settings panel's `c` key runs, so the command and the
 * panel can never disagree about the integration. Exit 0 when the key works, 1 when it does not.
 */
export async function jevCommand(args: JevArgs, out: Out): Promise<number> {
  const result = await jevModels();
  const settings = loadSettings();
  const payload = {
    ...result,
    base: result.baseUrl,
    jevEnabled: Boolean(settings.jevEnabled),
    verifierEnabled: Boolean(settings.jevVerifierEnabled),
    // What a real judgement costs is ~$0.001 and ~0.6 s; this probe only proves reachability.
    contract: { endpoint: `${result.baseUrl}/v1/systemone`, auth: "Bearer", primitives: ["noul", "choice", "score"] },
  };
  if (args.json) {
    json(out, payload);
    return result.ok ? 0 : 1;
  }
  if (!result.ok) {
    out.stderr(`jev: not reachable — ${result.error ?? "unknown"}\n  base   ${result.baseUrl}\n  key    ${result.source || "none (set one with `mini-tui settings jev-key <key>`)"}\n`);
    return 1;
  }
  out.stdout(`jev: ok\n  base    ${result.baseUrl}\n  key     ${result.source}\n  models  ${result.models.join(", ") || "—"}\n  asking  ${result.model} via POST /v1/systemone (noul | choice | score)\n`);
  out.stdout(`  toggles jev ${settings.jevEnabled ? "on" : "off"} · verifier ${settings.jevVerifierEnabled ? "on" : "off"}\n`);
  return 0;
}

/**
 * `mini-tui doctor [-m <model>]` - why is a `cliproxy/` model failing?
 *
 * cli-proxy is a local gateway, so a failed run there has four possible causes that all read the
 * same in the transcript. This names the first one that is wrong instead of leaving the user to
 * decode a log tail.
 */
export async function doctorCommand(args: DoctorArgs, out: Out): Promise<number> {
  const report = await runDoctor(args.model || defaultDoctorModel());
  if (args.json) return json(out, report), report.ok ? 0 : 1;
  out.stdout(`${formatDoctor(report)}\n`);
  return report.ok ? 0 : 1;
}
