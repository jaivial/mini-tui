/**
 * `$skill` prompts: skills live in `~/.claude/skills/<name>/SKILL.md` (Claude Code layout).
 * A prompt like `$good-code tidy the parser` sends mini the skill's instructions followed
 * by the request; the transcript collapses the block back to `$good-code …`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SKILLS_DIR = process.env.MINITUI_SKILLS_DIR ?? join(homedir(), ".claude", "skills");

export interface Skill {
  name: string;
  description: string;
  path: string;
}

/** Folded (`>`/`|`) or inline `description:` from the SKILL.md front matter. */
function frontMatterDescription(text: string): string {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return "";
  const lines = match[1]!.split("\n");
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

/** Every `<dir>/<name>/SKILL.md`, sorted by name (a missing dir is just no skills). */
export function listSkills(dir: string = SKILLS_DIR): Skill[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const name of names.sort()) {
    const path = join(dir, name, "SKILL.md");
    if (!existsSync(path)) continue;
    let description = "";
    try {
      description = frontMatterDescription(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    skills.push({ name, description, path });
  }
  return skills;
}

/** `$name rest…` → `{ name, request }` (null when the prompt is not a skill call). */
export function parseSkillPrompt(text: string): { name: string; request: string } | null {
  const match = /^\$([\w.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { name: match[1]!, request: (match[2] ?? "").trim() };
}

const SKILL_BLOCK = /^<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>\s*/;

/** The task mini receives: the skill's full instructions, then the user's request. */
export function expandSkillPrompt(text: string, dir: string = SKILLS_DIR): string | null {
  const call = parseSkillPrompt(text);
  if (!call) return null;
  const path = join(dir, call.name, "SKILL.md");
  let body: string;
  try {
    body = readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
  const request = call.request || `Apply the ${call.name} skill to the current project.`;
  return `<skill name="${call.name}" path="${path}">\n${body}\n</skill>\n\nFollow the skill above for this request:\n${request}`;
}

/** Transcript view of an expanded prompt: `$name request` (other text is unchanged). */
export function collapseSkillPrompt(text: string): string {
  const match = SKILL_BLOCK.exec(text);
  if (!match) return text;
  const request = text.slice(match[0].length).replace(/^Follow the skill above for this request:\n/, "");
  return `$${match[1]} ${request}`.trim();
}
