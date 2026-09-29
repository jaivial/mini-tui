/**
 * What the prompt bar offers while you type: slash commands at the start of the message, and
 * `$skill` references anywhere. Pure functions over (text, cursor), so the keyboard behaviour is
 * testable without a DOM. Skill matching is the terminal UI's own (`src/skillMatch.ts`).
 */
import { filterSkills, skillQueryAt } from "../../../src/skillMatch";
import type { Chip } from "./chips";
import type { CommandInfo, SkillInfo } from "./types";

export type Completion =
  | { kind: "command"; start: number; query: string; items: CommandInfo[] }
  | { kind: "skill"; start: number; query: string; items: SkillInfo[] };

/** Commands whose name starts with the query first, then ones that merely contain it. */
export function filterCommands(query: string, commands: CommandInfo[]): CommandInfo[] {
  const q = query.trim().toLowerCase().replace(/^\//, "");
  if (!q) return commands;
  const starts: CommandInfo[] = [];
  const has: CommandInfo[] = [];
  for (const c of commands) {
    if (c.name.startsWith(q)) starts.push(c);
    else if (c.name.includes(q) || c.detail.toLowerCase().includes(q)) has.push(c);
  }
  return [...starts, ...has];
}

/**
 * The completion for the caret, or null. A command is only offered while the first word of the
 * message is still being typed (`/mod|`): once there is a space the command is chosen and the
 * rest is its argument. A skill is offered for any `$word|` at the caret.
 */
export function completionAt(text: string, cursor: number, commands: CommandInfo[], skills: SkillInfo[]): Completion | null {
  const before = text.slice(0, cursor);
  const cmd = /^\/([\w-]*)$/.exec(before);
  if (cmd) {
    const items = filterCommands(cmd[1]!, commands);
    return items.length ? { kind: "command", start: 0, query: cmd[1]!, items } : null;
  }
  const skill = skillQueryAt(text, cursor);
  if (skill) {
    const items = filterSkills(skill.query, skills, (s) => s.name);
    return items.length ? { kind: "skill", start: skill.start, query: skill.query, items } : null;
  }
  return null;
}

/**
 * Picking from the menu lifts the pick out of the text into a chip. The `/query` or `$query` being typed
 * is removed (with the rest of a token the caret was inside, and one of any doubled space it leaves),
 * and the caret lands where the token was.
 */
export function pickCompletion(
  text: string,
  cursor: number,
  completion: Completion,
  index: number,
): { text: string; cursor: number; chip: Chip } {
  if (completion.kind === "command") {
    const chip: Chip = { kind: "command", name: completion.items[index]!.name };
    return { text: text.slice(cursor).replace(/^\s+/, ""), cursor: 0, chip };
  }
  const chip: Chip = { kind: "skill", name: completion.items[index]!.name };
  const before = text.slice(0, completion.start);
  let after = text.slice(cursor).replace(/^[\w.-]*/, "");
  // "use $pr on x" -> "use on x", not "use  on x"; and never leave leading blanks on an empty start.
  if (/\s$/.test(before) && /^\s/.test(after)) after = after.replace(/^\s/, "");
  const joined = before + after;
  const lead = joined.length - joined.replace(/^\s+/, "").length;
  return { text: joined.slice(lead), cursor: Math.max(0, before.length - lead), chip };
}

export interface ParsedCommand {
  name: string;
  arg: string;
}

/**
 * `/name rest` → `{name, arg}` when the message is a command for the web app itself.
 * `known: false` for a bare single word like `/modle` (a typo worth reporting); a path such as
 * `/etc/hosts` or free text is not a command and is sent to the agent as written.
 */
export function parseCommand(text: string, commands: CommandInfo[]): (ParsedCommand & { known: boolean }) | null {
  const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  const arg = (match[2] ?? "").trim();
  const known = commands.some((c) => c.name === name);
  if (known) return { name, arg, known };
  // An unknown word with an argument is prose that happens to start with a slash.
  return arg ? null : { name, arg, known: false };
}
