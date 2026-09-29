/**
 * Folder browsing for "where should this chat run?". One shape for this machine and for a remote host,
 * so the picker is the same component either way.
 *
 * Only directories are listed (names, never contents), hidden ones last, capped so a folder with 50 000
 * entries cannot stall the server or the page. The path a listing returns is the resolved, absolute one,
 * so `~`, `..` and symlinks all end up as a real folder the agent will actually start in.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
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

/** Sort: visible before hidden, then by name, case-insensitively and with numbers in order. */
function sortEntries(entries: FolderEntry[]): FolderEntry[] {
  return entries.sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

/** `~`, `~/x`, relative (to home) and absolute paths, to an absolute path. Empty means home. */
export function expandLocal(input: string, home = homedir()): string {
  const raw = input.trim();
  if (!raw || raw === "~") return home;
  if (raw.startsWith("~/")) return join(home, raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : resolve(home, raw);
}

export function listLocal(input: string, home = homedir()): FolderListing {
  const asked = expandLocal(input, home);
  let path: string;
  try {
    path = realpathSync(asked);
  } catch {
    throw new FolderError(`${asked} does not exist`, 404);
  }
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    /* unreadable */
  }
  if (!isDir) throw new FolderError(`${path} is not a folder`, 400);
  let names: import("node:fs").Dirent[];
  try {
    names = readdirSync(path, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new FolderError(code === "EACCES" || code === "EPERM" ? `no permission to open ${path}` : `could not open ${path}`, code === "EACCES" || code === "EPERM" ? 403 : 400);
  }
  const entries: FolderEntry[] = [];
  for (const d of names) {
    let dir = d.isDirectory();
    if (!dir && d.isSymbolicLink()) {
      try {
        dir = statSync(join(path, d.name)).isDirectory();
      } catch {
        dir = false; // a dangling link
      }
    }
    if (!dir) continue;
    const full = join(path, d.name);
    let git = false;
    try {
      git = statSync(join(full, ".git")).isDirectory() || statSync(join(full, ".git")).isFile();
    } catch {
      /* not a repo */
    }
    entries.push({ name: d.name, path: full, hidden: d.name.startsWith("."), git });
  }
  sortEntries(entries);
  const parent = dirname(path) === path ? null : dirname(path);
  return { path, parent, home, entries: entries.slice(0, FOLDER_LIMIT), truncated: entries.length > FOLDER_LIMIT };
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
