/**
 * Folder browsing for "where should this chat run?". One shape for this machine and for a remote host,
 * so the picker is the same component either way.
 *
 * Only directories are listed (names, never contents), hidden ones last, capped so a folder with 50 000
 * entries cannot stall the server or the page -- the cap bounds the work as well as the answer, and
 * the listing hands the thread back while it reads (E45). The path a listing returns is the resolved, absolute one,
 * so `~`, `..` and symlinks all end up as a real folder the agent will actually start in.
 */
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { sshArgs, type SshTarget } from "./ssh";

export const FOLDER_LIMIT = 500;

export interface FolderEntry {
  name: string;
  path: string;
  hidden: boolean;
  /** A git work tree (it has `.git`): shown with a badge, the usual thing to start in. */
  git: boolean;
}

export interface FolderListing {
  /** The folder listed, absolute and resolved. */
  path: string;
  /** Its parent, or null at the root. */
  parent: string | null;
  home: string;
  entries: FolderEntry[];
  /** More subfolders than FOLDER_LIMIT: the rest are not shown (type a path to reach them). */
  truncated: boolean;
}

export class FolderError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 502 | 504,
  ) {
    super(message);
  }
}

/**
 * ONE shared `Intl.Collator`, because `String.localeCompare` builds a fresh collator on every
 * single comparison. Measured on a 30 000-folder directory: 1 018 ms of the 1 165 ms this listing
 * took was the sort, and 27 ms of it is the same comparison with the collator reused (E45).
 */
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Visible before hidden, then by name with numbers in order and case and accents ignored. A
 * collation tie ("a" vs "A") is broken by codepoint, so the answer never depends on the order in
 * which the filesystem happened to hand the names over.
 */
function compareNames(a: string, b: string): number {
  if (a === b) return 0;
  return Number(a.startsWith(".")) - Number(b.startsWith(".")) || COLLATOR.compare(a, b) || (a < b ? -1 : 1);
}

/** Sort: visible before hidden, then by name, case-insensitively and with numbers in order. */
function sortEntries(entries: FolderEntry[]): FolderEntry[] {
  return entries.sort((a, b) => compareNames(a.name, b.name));
}

/** One subfolder candidate: a directory entry, or a link -- only a `stat` can say about a link. */
export interface FolderCandidate {
  name: string;
  /** True for a symlink: its kind in the dirent says nothing, so it takes a probe to know. */
  link: boolean;
}

/** What the selection may ask about a candidate. Injected so it can be measured without a disk. */
export interface FolderProbes {
  /** Asked only about links. */
  isFolder: (name: string) => Promise<boolean> | boolean;
  /** Asked only about entries that are actually returned. */
  hasGit: (name: string) => Promise<boolean> | boolean;
}

/** Candidates per slice: bounded, so a huge folder cannot monopolise the thread it runs on. */
const SLICE = 2_048;
const yieldLoop = () => new Promise<void>((done) => setImmediate(done));

/**
 * The first `limit` folders of a directory, in the order the picker shows, and whether there are
 * more than `limit`.
 *
 * THE CAP HAS TO BOUND THE WORK AND NOT ONLY THE ANSWER. The old local listing walked every entry
 * of the folder and stat-ed every one of them -- 30 000 stats and 30 000 caught ENOENT exceptions
 * (the `.git` that is not there) for a 30 000-folder directory whose answer is 500 entries, on the
 * server's one thread, which froze every other request on the box for over a second (E45). Only the
 * head of the collated order can
 * change the answer, and the shortest head that can hold `limit` folders plus one more to report
 * truncation is `limit + 1 + links`: at the very worst every link turns out not to be a folder.
 * Everything past it sorts after the answer.
 */
export async function selectFolders(
  candidates: readonly FolderCandidate[],
  probes: FolderProbes,
  limit = FOLDER_LIMIT,
): Promise<{ entries: Array<{ name: string; hidden: boolean; git: boolean }>; truncated: boolean }> {
  if (limit <= 0) return { entries: [], truncated: candidates.length > 0 };
  let links = 0;
  for (const c of candidates) if (c.link) links++;
  const window = Math.min(candidates.length, limit + 1 + links);
  const top: FolderCandidate[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (top.length === window && compareNames(c.name, top[window - 1]!.name) >= 0) continue;
    let lo = 0, hi = top.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareNames(c.name, top[mid]!.name) < 0) hi = mid;
      else lo = mid + 1;
    }
    top.splice(lo, 0, c);
    if (top.length > window) top.pop();
    if (i % SLICE === SLICE - 1) await yieldLoop();
  }
  const entries: Array<{ name: string; hidden: boolean; git: boolean }> = [];
  let truncated = false;
  for (const c of top) {
    if (c.link && !(await probes.isFolder(c.name))) continue;
    if (entries.length === limit) {
      truncated = true;
      break;
    }
    entries.push({ name: c.name, hidden: c.name.startsWith("."), git: await probes.hasGit(c.name) });
  }
  return { entries, truncated };
}

/** `~`, `~/x`, relative (to home) and absolute paths, to an absolute path. Empty means home. */
export function expandLocal(input: string, home = homedir()): string {
  const raw = input.trim();
  if (!raw || raw === "~") return home;
  if (raw.startsWith("~/")) return join(home, raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : resolve(home, raw);
}

/**
 * The subfolders of a folder on this machine, resolved to real absolute paths.
 *
 * Async, and it hands the thread back every slice, on purpose: this runs on the server's one
 * thread, and a folder with many subfolders used to freeze every other request on the box while it
 * worked through all of them (E45). Each returned entry costs exactly one stat, and the cap bounds
 * how many are ever looked at.
 */
export async function listLocal(input: string, home = homedir()): Promise<FolderListing> {
  const asked = expandLocal(input, home);
  let path: string;
  try {
    path = await realpath(asked);
  } catch {
    throw new FolderError(`${asked} does not exist`, 404);
  }
  // `throwIfNoEntry: false` answers "no" instead of throwing: a missing `.git` is the normal case,
  // and throwing it 30 000 times is not something a listing should ever do.
  const at = (p: string) => stat(p, { throwIfNoEntry: false }).catch(() => undefined);
  if (!(await at(path))?.isDirectory()) throw new FolderError(`${path} is not a folder`, 400);
  let names: import("node:fs").Dirent[];
  try {
    names = await readdir(path, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const denied = code === "EACCES" || code === "EPERM";
    throw new FolderError(denied ? `no permission to open ${path}` : `could not open ${path}`, denied ? 403 : 400);
  }
  const candidates: FolderCandidate[] = [];
  for (const d of names) {
    if (d.isDirectory()) candidates.push({ name: d.name, link: false });
    else if (d.isSymbolicLink()) candidates.push({ name: d.name, link: true });
  }
  const picked = await selectFolders(candidates, {
    // A folder's kind is already in the dirent: only a link costs a probe.
    isFolder: async (name) => !!(await at(join(path, name)))?.isDirectory(),
    // One stat, not the old two plus a thrown exception for every folder that was not a repo.
    hasGit: async (name) => {
      const dot = await at(join(path, name, ".git"));
      return !!dot && (dot.isDirectory() || dot.isFile());
    },
  });
  return {
    path,
    parent: dirname(path) === path ? null : dirname(path),
    home,
    entries: picked.entries.map((e) => ({ name: e.name, path: join(path, e.name), hidden: e.hidden, git: e.git })),
    truncated: picked.truncated,
  };
}

/** Single-quote for a POSIX shell. */
const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/**
 * The remote listing: one `ssh … bash -s` with a short script on stdin (the path travels quoted, never
 * interpolated raw). It prints a header (resolved path, home) and one line per subfolder:
 * `<git 0|1>\t<name>`. Names with a newline or a tab cannot be told apart from the protocol and are
 * skipped, which is safer than guessing.
 */
export function remoteListScript(input: string): string {
  const raw = input.trim();
  // `~` and `~/x` are expanded by the remote shell from its own $HOME; anything else is taken as given.
  const target = !raw || raw === "~" ? '"$HOME"' : raw.startsWith("~/") ? `"$HOME"/${q(raw.slice(2))}` : isAbsolute(raw) ? q(raw) : `"$HOME"/${q(raw)}`;
  return `set -u
t=${target}
if [ ! -e "$t" ]; then echo "ERR 404 $t does not exist"; exit 0; fi
if [ ! -d "$t" ]; then echo "ERR 400 $t is not a folder"; exit 0; fi
if ! cd "$t" 2>/dev/null; then echo "ERR 403 no permission to open $t"; exit 0; fi
printf 'PATH\\t%s\\n' "$(pwd -P)"
printf 'HOME\\t%s\\n' "$HOME"
n=0
for d in * .[!.]* ..?*; do
  [ -d "$d" ] || continue
  case "$d" in *'
'*|*'	'*) continue;; esac
  n=$((n+1))
  if [ "$n" -gt ${FOLDER_LIMIT} ]; then echo "MORE"; break; fi
  if [ -e "$d/.git" ]; then g=1; else g=0; fi
  printf '%s\\t%s\\n' "$g" "$d"
done
`;
}

export function parseRemoteListing(out: string): FolderListing {
  const lines = out.split("\n");
  const err = lines.find((l) => l.startsWith("ERR "));
  if (err) {
    const m = /^ERR (\d{3}) (.*)$/.exec(err);
    const status = Number(m?.[1]);
    throw new FolderError(m?.[2] ?? "could not list that folder", status === 404 || status === 403 || status === 400 ? status : 400);
  }
  const path = lines.find((l) => l.startsWith("PATH\t"))?.slice(5) ?? "";
  const home = lines.find((l) => l.startsWith("HOME\t"))?.slice(5) ?? "";
  if (!path.startsWith("/")) throw new FolderError("the host answered, but not with a folder listing", 502);
  const entries: FolderEntry[] = [];
  for (const l of lines) {
    const m = /^([01])\t(.+)$/.exec(l);
    if (!m) continue;
    const name = m[2]!;
    if (name === "." || name === ".." || name.includes("/")) continue;
    entries.push({ name, path: path === "/" ? `/${name}` : `${path}/${name}`, hidden: name.startsWith("."), git: m[1] === "1" });
  }
  sortEntries(entries);
  const parent = path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/";
  return { path, parent, home, entries, truncated: lines.includes("MORE") };
}

export async function listRemote(target: Omit<SshTarget, "workdir" | "model">, input: string, timeoutMs = 12_000): Promise<FolderListing> {
  const proc = Bun.spawn({
    cmd: ["ssh", "-T", "-o", "ConnectTimeout=8", ...sshArgs({ ...target, workdir: "" }), "bash", "-s"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(remoteListScript(input));
  proc.stdin.end();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (timedOut) throw new FolderError("the host did not answer in time", 504);
  if (code !== 0) {
    const reason = err.trim().split("\n").filter(Boolean).pop()?.slice(0, 200) || `ssh exited with code ${code}`;
    throw new FolderError(`could not reach the host: ${reason}`, 502);
  }
  return parseRemoteListing(out);
}
