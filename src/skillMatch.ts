/**
 * The pure half of `$skill` handling: finding references, ranking matches, and completing a
 * `$query` in place. No node imports, so the browser bundle can share exactly the matching the
 * terminal UI uses (`src/skills.ts` re-exports everything here and adds the filesystem half).
 */

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

/** Name words: `pr-body` → [`pr`, `body`] (also splits `_`, `.`, spaces and camelCase). */
function nameWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s._-]+/)
    .filter(Boolean);
}

/** Every character of `needle` appears in `hay`, in order (`prb` ~ `pr-body`). */
function isSubsequence(needle: string, hay: string): boolean {
  let at = 0;
  for (const char of hay) if (char === needle[at]) at++;
  return at === needle.length;
}

/**
 * How well a `$query` matches a skill name, lower is better; `null` = no match. Word order
 * never matters: `body` and `body-pr` both find `pr-body`.
 *   0 name starts with the query        `$pr`       → pr-body
 *   1 a word of the name starts with it `$body`     → pr-body
 *   2 the name contains it              `$ody`      → pr-body
 *   3 every query word is in the name, any order    `$body-pr`, `$fix.pr` → pr-fix-loop
 *   4 every query word's letters, in order, in some word  `$bdy`  → pr-body
 */
export function skillMatchRank(query: string, name: string): number | null {
  const q = query.trim().toLowerCase().replace(/^\$/, "");
  const n = name.toLowerCase();
  if (!q) return 0;
  if (n.startsWith(q)) return 0;
  const words = nameWords(name);
  if (words.some((word) => word.startsWith(q))) return 1;
  if (n.includes(q)) return 2;
  const terms = nameWords(q);
  if (terms.length && terms.every((term) => n.includes(term))) return 3;
  const joined = n.replace(/[\s._-]+/g, "");
  if (terms.length && terms.every((term) => words.some((word) => isSubsequence(term, word)) || isSubsequence(term, joined))) return 4;
  return null;
}

/** Skills for the `$` panel, best matches first (a stable sort keeps the folder order). */
export function filterSkills<T>(query: string, items: T[], nameOf: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, rank: skillMatchRank(query, nameOf(item)) }))
    .filter((row): row is { item: T; index: number; rank: number } => row.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((row) => row.item);
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
