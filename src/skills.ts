/**
 * `$skill` references anywhere in a prompt.
 *
 * mini-tui owns its skills folder (`~/.config/mini-tui/skills/<name>/SKILL.md`). On startup (and
 * at install, `bun run sync-skills`) every skill found in `~/.claude/skills` — including
 * symlinked skills and the nested `synced/<bucket>/<name>/` layout — that the folder does not
 * have yet is copied in. Copies are never overwritten: edits made in mini-tui stay.
 *
 * Skills bundled with mini-tui (`<repo>/skills/<name>/`, e.g. `e2e`) are native: installed into
 * that folder on every startup and install, and refreshed when the bundled copy changes, unless
 * the user edited their copy (then it is left alone) or deleted it (then it stays deleted).
 *
 * A prompt such as `follow $good-code, then use $better-ui and $pr-body` is sent to mini as
 * one `<skills>` block with each referenced skill's instructions, then the prompt verbatim.
 * The transcript collapses the block back to the prompt as typed.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** mini-tui's own skills folder (what the `$` palette lists and prompts expand from). */
export const SKILLS_DIR = process.env.MINITUI_SKILLS_DIR ?? join(homedir(), ".config", "mini-tui", "skills");
/** Where skills are inherited from (Claude Code layout). */
export const CLAUDE_SKILLS_DIR = process.env.MINITUI_CLAUDE_SKILLS_DIR ?? join(homedir(), ".claude", "skills");
/** Skills shipped with mini-tui itself (the repo's `skills/` folder). */
export const BUNDLED_SKILLS_DIR = process.env.MINITUI_BUNDLED_SKILLS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
/** Names imported by the last syncs, so a skill deleted in mini-tui is not re-imported. */
const SYNC_STATE = ".synced-from-claude.json";
/** `name → hash` of each bundled skill as last installed (detects user edits and deletions). */
const BUNDLED_STATE = ".bundled.json";

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

/** A stable hash of a skill folder's files (relative paths + contents). */
export function hashSkillDir(dir: string): string {
  const hash = createHash("sha256");
  const walk = (base: string) => {
    for (const name of readdirSync(base).sort()) {
      if (name.startsWith(".")) continue;
      const path = join(base, name);
      if (isDir(path)) walk(path);
      else {
        hash.update(relative(dir, path));
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  };
  walk(dir);
  return hash.digest("hex").slice(0, 16);
}

export interface BundledResult {
  installed: string[];
  updated: string[];
  /** Bundled skills whose copy the user edited: left as they are. */
  kept: string[];
  dir: string;
}

/**
 * Install mini-tui's bundled skills into `to`: new ones are copied, ones still identical to
 * the copy last installed are refreshed to the bundled version, edited copies are kept, and a
 * bundled skill the user deleted is not reinstalled. Bundled skills win over a same-named skill
 * imported from ~/.claude (imported copies are not user edits).
 */
export function installBundledSkills(from: string = BUNDLED_SKILLS_DIR, to: string = SKILLS_DIR): BundledResult {
  const result: BundledResult = { installed: [], updated: [], kept: [], dir: to };
  const source = discoverSkills(from);
  if (source.size === 0) return result;
  mkdirSync(to, { recursive: true });
  const statePath = join(to, BUNDLED_STATE);
  let state: Record<string, string> = {};
  try {
    state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, string>;
  } catch {
    state = {};
  }
  let imported: string[] = [];
  try {
    imported = JSON.parse(readFileSync(join(to, SYNC_STATE), "utf8")) as string[];
  } catch {
    imported = [];
  }
  let changed = false;
  for (const [name, folder] of source) {
    const target = join(to, name);
    const bundledHash = hashSkillDir(folder);
    const known = state[name];
    try {
      if (!existsSync(target)) {
        if (known) continue; // installed before, deleted by the user: stays deleted
        cpSync(realpathSync(folder), target, { recursive: true, dereference: true });
        result.installed.push(name);
      } else {
        const current = hashSkillDir(target);
        if (current === bundledHash) {
          if (known === bundledHash) continue;
        } else if (known === current || (!known && imported.includes(name))) {
          rmSync(target, { recursive: true, force: true });
          cpSync(realpathSync(folder), target, { recursive: true, dereference: true });
          result.updated.push(name);
        } else {
          result.kept.push(name); // the user's own skill of that name, or an edited copy
          continue;
        }
      }
      state[name] = bundledHash;
      changed = true;
    } catch {
      // unreadable source or a race: try again next startup
    }
  }
  if (changed) {
    try {
      writeFileSync(statePath, `${JSON.stringify(state, null, 1)}\n`);
    } catch {
      // best-effort bookkeeping
    }
  }
  return result;
}

/** Bundled skills first (they are mini-tui's own), then the ~/.claude import. */
export function syncAllSkills(): { added: string[]; bundled: BundledResult } {
  let bundled: BundledResult = { installed: [], updated: [], kept: [], dir: SKILLS_DIR };
  try {
    bundled = installBundledSkills();
  } catch {
    // never block startup
  }
  const added = syncSkills().added;
  return { added: [...bundled.installed, ...added], bundled };
}

export {
  SKILL_TOKEN,
  filterSkills,
  findSkillRefs,
  insertSkill,
  skillMatchRank,
  skillQueryAt,
  type SkillRef,
} from "./skillMatch";
import { findSkillRefs } from "./skillMatch";

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
