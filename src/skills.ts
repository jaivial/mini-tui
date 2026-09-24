/**
 * `$skill` references anywhere in a prompt.
 *
 * mini-tui owns its skills folder (`~/.config/mini-tui/skills/<name>/SKILL.md`). On startup (and
 * at install, `bun run sync-skills`) every skill found in `~/.claude/skills` — including
 * symlinked skills and the nested `synced/<bucket>/<name>/` layout — that the folder does not
 * have yet is copied in. Copies are never overwritten: edits made in mini-tui stay.
 *
 * A prompt such as `follow $good-code, then use $better-ui and $pr-body` is sent to mini as
 * one `<skills>` block with each referenced skill's instructions, then the prompt verbatim.
 * The transcript collapses the block back to the prompt as typed.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** mini-tui's own skills folder (what the `$` palette lists and prompts expand from). */
export const SKILLS_DIR = process.env.MINITUI_SKILLS_DIR ?? join(homedir(), ".config", "mini-tui", "skills");
/** Where skills are inherited from (Claude Code layout). */
export const CLAUDE_SKILLS_DIR = process.env.MINITUI_CLAUDE_SKILLS_DIR ?? join(homedir(), ".claude", "skills");
/** Names imported by the last syncs, so a skill deleted in mini-tui is not re-imported. */
const SYNC_STATE = ".synced-from-claude.json";

export interface Skill {
  name: string;
  description: string;
  path: string;
}

/** Folded (`>`/`|`) or inline `description:` from the SKILL.md front matter. */
function frontMatterDescription(text: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return "";
  const lines = match[1]!.split(/\r?\n/);
  const at = lines.findIndex((line) => line.startsWith("description:"));
  if (at < 0) return "";
  const inline = lines[at]!.slice("description:".length).trim();
  if (inline && !/^[>|][-+]?$/.test(inline)) return inline.replace(/^["']|["']$/g, "");
  const folded: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!/^\s/.test(line)) break;
    folded.push(line.trim());
  }
  return folded.join(" ").trim();
}

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory(); // follows symlinks
  } catch {
    return false;
  }
};

/** `name → folder` of every skill under `dir`: `<name>/SKILL.md`, plus one level of bucket
 * folders without a SKILL.md of their own (`synced/<bucket>/<name>/SKILL.md`). Top level wins. */
export function discoverSkills(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  const scan = (base: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(base).sort();
    } catch {
      return;
    }
    const nested: string[] = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const path = join(base, name);
      if (!isDir(path)) continue;
      if (existsSync(join(path, "SKILL.md"))) {
        if (!found.has(name) && /^[\w.-]+$/.test(name)) found.set(name, path);
      } else if (depth > 0) nested.push(path);
    }
    for (const path of nested) scan(path, depth - 1);
  };
  scan(dir, 2);
  return found;
}

/** Every skill in `dir`, sorted by name (a missing dir is just no skills). */
export function listSkills(dir: string = SKILLS_DIR): Skill[] {
  const skills: Skill[] = [];
  for (const [name, folder] of [...discoverSkills(dir)].sort(([a], [b]) => a.localeCompare(b))) {
    const path = join(folder, "SKILL.md");
    try {
      skills.push({ name, description: frontMatterDescription(readFileSync(path, "utf8")), path });
    } catch {
      // unreadable: skip
    }
  }
  return skills;
}

export interface SyncResult {
  added: string[];
  dir: string;
}

/**
 * Copy the skills of `from` that `to` does not have (never overwrites, never re-imports one the
 * user deleted from `to`). Symlinks are resolved so the copy is self-contained.
 */
export function syncSkills(from: string = CLAUDE_SKILLS_DIR, to: string = SKILLS_DIR): SyncResult {
  const result: SyncResult = { added: [], dir: to };
  const source = discoverSkills(from);
  if (source.size === 0) return result;
  mkdirSync(to, { recursive: true });
  const statePath = join(to, SYNC_STATE);
  let imported: string[] = [];
  try {
    imported = JSON.parse(readFileSync(statePath, "utf8")) as string[];
  } catch {
    imported = [];
  }
  const present = new Set(discoverSkills(to).keys());
  for (const [name, folder] of source) {
    if (present.has(name) || imported.includes(name) || existsSync(join(to, name))) continue;
    try {
      cpSync(realpathSync(folder), join(to, name), { recursive: true, dereference: true, errorOnExist: true, force: false });
      result.added.push(name);
    } catch {
      // unreadable source or a race: try again next startup
    }
  }
  if (result.added.length) {
    try {
      writeFileSync(statePath, `${JSON.stringify([...new Set([...imported, ...result.added])].sort(), null, 1)}\n`);
    } catch {
      // best-effort bookkeeping
    }
  }
  return result;
}

/** A `$name` token: at the start or after whitespace/opening punctuation (`costs $5` has no
 * name characters that start a skill, `a$b` is not a reference). */
export const SKILL_TOKEN = /(^|[\s([{"'`,;])\$([A-Za-z][\w.-]*[\w]|[A-Za-z])/g;

export interface SkillRef {
  name: string;
  /** Offset of the `$`. */
  start: number;
  /** Offset just past the name. */
  end: number;
}

/** Every `$name` in `text` whose name is in `known` (all of them when `known` is omitted). */
export function findSkillRefs(text: string, known?: Set<string>): SkillRef[] {
  const refs: SkillRef[] = [];
  for (const match of text.matchAll(SKILL_TOKEN)) {
    const name = match[2]!;
    if (known && !known.has(name)) continue;
    const start = match.index! + match[1]!.length;
    refs.push({ name, start, end: start + 1 + name.length });
  }
  return refs;
}

/** The `$query` being typed at `cursor` (for the completion panel), or null. */
export function skillQueryAt(text: string, cursor: number = text.length): { start: number; query: string } | null {
  const before = text.slice(0, cursor);
  const match = /(^|[\s([{"'`,;])\$([\w.-]*)$/.exec(before);
  if (!match) return null;
  return { start: match.index + match[1]!.length, query: match[2]! };
}

/** Put `$name ` in place of the `$query` at `cursor`; returns the new text and cursor offset. */
export function insertSkill(text: string, cursor: number, name: string): { text: string; cursor: number } {
  const at = skillQueryAt(text, cursor);
  const start = at ? at.start : cursor;
  const rest = text.slice(cursor).replace(/^[\w.-]*/, "");
  const token = `$${name}`;
  const glue = rest.startsWith(" ") ? "" : " ";
  return { text: text.slice(0, start) + token + glue + rest, cursor: start + token.length + 1 };
}

const SKILLS_BLOCK = /^<skills>\n[\s\S]*?\n<\/skills>\n\n/;
const SKILL_BLOCK_LEGACY = /^<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>\s*/;
const REQUEST_HEADER = "Follow the skills above where the request references them ($name):\n";

/**
 * The task mini receives: the instructions of every skill referenced with `$name`, then the
 * prompt verbatim. Returns `{ task, missing }`: unknown `$names` are reported, not sent.
 */
export function expandSkills(text: string, dir: string = SKILLS_DIR): { task: string; used: string[]; missing: string[] } {
  const available = discoverSkills(dir);
  const used: string[] = [];
  const missing: string[] = [];
  for (const ref of findSkillRefs(text)) {
    const bucket = available.has(ref.name) ? used : missing;
    if (!bucket.includes(ref.name)) bucket.push(ref.name);
  }
  if (!used.length) return { task: text, used, missing };
  const blocks = used.map((name) => {
    const path = join(available.get(name)!, "SKILL.md");
    return `<skill name="${name}" path="${path}">\n${readFileSync(path, "utf8").trim()}\n</skill>`;
  });
  const task = `<skills>\n${blocks.join("\n\n")}\n</skills>\n\n${REQUEST_HEADER}${text}`;
  return { task, used, missing };
}

/** Transcript view of an expanded prompt: the prompt as typed (other text is unchanged). */
export function collapseSkillPrompt(text: string): string {
  const block = SKILLS_BLOCK.exec(text);
  if (block) return text.slice(block[0].length).replace(REQUEST_HEADER, "").trim();
  const legacy = SKILL_BLOCK_LEGACY.exec(text);
  if (!legacy) return text;
  const request = text.slice(legacy[0].length).replace(/^Follow the skill above for this request:\n/, "");
  return `$${legacy[1]} ${request}`.trim();
}
