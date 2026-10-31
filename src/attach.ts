/**
 * Files staged with `/attach` in the terminal UI, sent with the next prompt.
 *
 * The rules are the web server's own (src/web/attachments.ts: the type allowlist, 15 MB, the
 * bytes must look like the extension), checked when a file is staged so a refusal reads at once
 * instead of after the prompt went out. Where the prompt goes decides what happens to the files:
 *   - dispatcher chat / remote workspace: uploaded to the server (`POST /api/attachments`) and
 *     their refs ride with the prompt, exactly as the web app sends them;
 *   - a local session: the agent runs on this machine and reads files by path, so the prompt
 *     itself names them (`localAttachmentText`); nothing is copied.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

import { ATTACH_ACCEPT, ATTACH_MAX_BYTES, attachmentMime, sniffMatches } from "./web/attachments";
import { expandHome } from "./workspaces";

export interface StagedAttachment {
  /** Absolute path on this machine. */
  path: string;
  name: string;
  mime: string;
  size: number;
}

/** The server resolves at most this many refs per prompt (src/web/sessions.ts resolveAttachments). */
export const MAX_STAGED = 10;

/** `1.2 MB` (the web prompt bar's unit). */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The paths of an `/attach` argument list: whitespace separates them; a path with spaces is
 * quoted ("…" or '…') or has its spaces escaped (`my\ file.png`, what Tab completion writes).
 */
export function parseAttachArgs(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let pending = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      current += text[++i];
      pending = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      pending = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (pending || current) out.push(current);
      current = "";
      pending = false;
      continue;
    }
    current += ch;
  }
  if (pending || current) out.push(current);
  return out.filter(Boolean);
}

/** Spaces escaped the way `parseAttachArgs` reads them back. */
export function escapeAttachPath(path: string): string {
  return path.replace(/([\\\s"'])/g, "\\$1");
}

/** Check one file against the server's rules; throws an Error that names the file and the reason. */
export function stageFile(input: string, cwd: string, home = homedir()): StagedAttachment {
  const path = input.startsWith("~") || isAbsolute(input) ? expandHome(input, home) : resolve(cwd, input);
  const name = basename(path);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`${input}: no such file`);
  }
  if (stat.isDirectory()) throw new Error(`${input}: is a folder (attach files one by one)`);
  if (!stat.isFile()) throw new Error(`${input}: not a regular file`);
  const mime = attachmentMime(name);
  if (!mime) throw new Error(`${name}: this type is not accepted (accepted: ${ATTACH_ACCEPT.replaceAll(",", " ")})`);
  if (!stat.size) throw new Error(`${name}: the file is empty`);
  if (stat.size > ATTACH_MAX_BYTES) throw new Error(`${name}: ${humanSize(stat.size)} is over the ${Math.round(ATTACH_MAX_BYTES / 1024 / 1024)} MB limit`);
  const head = new Uint8Array(Math.min(stat.size, 4096));
  try {
    const fd = openSync(path, "r");
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    throw new Error(`${input}: cannot be read (${(error as Error).message})`);
  }
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (!sniffMatches(ext, head)) throw new Error(`${name}: the content is not a valid ${ext} (the server would refuse it)`);
  return { path, name, mime, size: stat.size };
}

/** What a local agent gets behind the prompt: the files by path (it runs on this machine). */
export function localAttachmentText(files: StagedAttachment[]): string {
  return [`Attached files (on this machine; read them from these paths):`, ...files.map((f) => `- ${f.path} (${f.mime}, ${humanSize(f.size)})`)].join("\n");
}
