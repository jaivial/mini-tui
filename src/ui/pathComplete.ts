import { readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

import { expandHome } from "../workspaces";

/**
 * Tab completion of a folder path as typed (`~/pro` → `~/projects/`). Returns the completed text
 * and, when several folders match, their names (for a hint line). Only directories complete;
 * dot-folders only when the typed part starts with a dot.
 */
export function completeFolder(input: string, home = homedir()): { text: string; matches: string[] } {
  return completePath(input, { home });
}

/**
 * `completeFolder` with options: `files` completes files too (a unique folder still gets its
 * `/`, a unique file none; folders in `matches` end in `/`), and `base` is the folder a relative
 * path is read from (default: home, as the workspace picker always did).
 */
export function completePath(input: string, opts: { home?: string; base?: string; files?: boolean } = {}): { text: string; matches: string[] } {
  const home = opts.home ?? homedir();
  const typed = input === "~" ? "~/" : input;
  const endsWithSlash = typed.endsWith("/");
  const rooted = typed ? typed.startsWith("~") || isAbsolute(typed) : !opts.base;
  const absolute = rooted ? expandHome(typed || "~", home) : resolve(opts.base ?? home, typed || ".");
  const parent = endsWithSlash || !typed ? absolute : dirname(absolute);
  const partial = endsWithSlash || !typed ? "" : absolute.slice(parent.length).replace(/^\//, "");
  const dirs = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(parent).filter((name) => {
      if (!name.startsWith(partial)) return false;
      if (name.startsWith(".") && !partial.startsWith(".")) return false;
      try {
        const stat = statSync(join(parent, name));
        if (stat.isDirectory()) dirs.add(name);
        return stat.isDirectory() || (Boolean(opts.files) && stat.isFile());
      } catch {
        return false;
      }
    });
  } catch {
    return { text: input, matches: [] };
  }
  names.sort();
  if (!names.length) return { text: input, matches: [] };
  const prefix = names.reduce((common, name) => {
    let i = 0;
    while (i < common.length && i < name.length && common[i] === name[i]) i++;
    return common.slice(0, i);
  });
  // keep the user's spelling of the part already typed (`~/` stays `~/`)
  const base = !typed ? (opts.base ? "" : "~/") : endsWithSlash ? typed : typed.slice(0, typed.length - partial.length);
  const completed = base + prefix + (names.length === 1 && dirs.has(names[0]!) ? "/" : "");
  const matches = names.length > 1 ? (opts.files ? names.map((name) => (dirs.has(name) ? `${name}/` : name)) : names) : [];
  return { text: completed, matches };
}
