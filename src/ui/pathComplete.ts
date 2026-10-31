import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { expandHome } from "../workspaces";

/**
 * Tab completion of a folder path as typed (`~/pro` → `~/projects/`). Returns the completed text
 * and, when several folders match, their names (for a hint line). Only directories complete;
 * dot-folders only when the typed part starts with a dot.
 */
export function completeFolder(input: string, home = homedir()): { text: string; matches: string[] } {
  const typed = input === "~" ? "~/" : input;
  const endsWithSlash = typed.endsWith("/");
  const absolute = expandHome(typed || "~", home);
  const parent = endsWithSlash || !typed ? absolute : dirname(absolute);
  const partial = endsWithSlash || !typed ? "" : absolute.slice(parent.length).replace(/^\//, "");
  let names: string[] = [];
  try {
    names = readdirSync(parent).filter((name) => {
      if (!name.startsWith(partial)) return false;
      if (name.startsWith(".") && !partial.startsWith(".")) return false;
      try {
        return statSync(join(parent, name)).isDirectory();
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
  const base = endsWithSlash || !typed ? (typed || "~/").replace(/\/?$/, "/") : typed.slice(0, typed.length - partial.length);
  const completed = base + prefix + (names.length === 1 ? "/" : "");
  return { text: completed, matches: names.length > 1 ? names : [] };
}
