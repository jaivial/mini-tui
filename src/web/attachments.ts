/**
 * Attachments: files uploaded from the prompt bar, and images the agent
 * produces, kept on this machine and served back under /api/attachments/:id.
 *
 * Files land in the mini-tui data dir (`~/.local/share/mini-tui/attachments`,
 * MINITUI_ATTACHMENTS_DIR overrides), grouped by month, under an opaque id —
 * never under a name a client chose. A one-line JSON index records the original
 * name, type and size; `get` reads only entries of that index, so a request can
 * never reach for an arbitrary path.
 *
 * Limits are deliberate: 15 MB per file (a chat attachment, not a backup
 * target) and an allowlist of everyday types (images, documents, audio/video,
 * zip). SVG is excluded on purpose — served inline it is executable markup.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { homedir } from "node:os";

export const ATTACH_MAX_BYTES = 15 * 1024 * 1024;

/** Extension → MIME. The allowlist IS the accepted set; anything else is refused. */
const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".log": "text/plain",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".zip": "application/zip",
};

/** The `accept` hint the prompt bar shows; the server enforces the same set. */
export const ATTACH_ACCEPT = Object.keys(TYPES).join(",");

export interface Attachment {
  id: string;
  /** The name the file came with (metadata only; never used on disk). */
  name: string;
  mime: string;
  size: number;
  /** Absolute path on this machine — what the agent reads. */
  path: string;
  /** How the browser fetches it. */
  url: string;
}

export function attachmentsDir(): string {
  return process.env.MINITUI_ATTACHMENTS_DIR ?? join(homedir(), ".local/share/mini-tui/attachments");
}

function index_path(): string {
  return join(attachmentsDir(), "index.jsonl");
}

/** The name we keep in metadata: no paths, no control characters, bounded. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const clean = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return (clean || "file").slice(0, 120);
}

/** True when `id` is one of ours (16 hex chars): anything else never touches disk. */
const ID_SHAPE = /^[0-9a-f]{16}$/;
export function isAttachmentId(id: string): boolean {
  return ID_SHAPE.test(id);
}

export class AttachError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function monthDir(now = new Date()): string {
  const dir = join(attachmentsDir(), `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The metadata of every attachment, oldest first. Reads the (small) index. */
export function listAttachments(): Attachment[] {
  const file = index_path();
  if (!existsSync(file)) return [];
  const out: Attachment[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (typeof rec.id === "string" && typeof rec.path === "string" && typeof rec.mime === "string" && typeof rec.size === "number" && typeof rec.name === "string") {
        out.push({ id: rec.id, name: rec.name, mime: rec.mime, size: rec.size, path: rec.path, url: `/api/attachments/${rec.id}` });
      }
    } catch {
      // a torn last line (a crash mid-append) only loses that one entry
    }
  }
  return out;
}

const byId = new Map<string, Attachment>();
let indexLoaded = false;

function loadIndex(): void {
  if (indexLoaded) return;
  indexLoaded = true;
  for (const att of listAttachments()) byId.set(att.id, att);
}

export function getAttachment(id: string): Attachment | null {
  if (!isAttachmentId(id)) return null;
  loadIndex();
  const hit = byId.get(id);
  return hit && existsSync(hit.path) ? hit : null;
}

/**
 * Store uploaded bytes. Throws AttachError (client-fault status inside) for a
 * disallowed type or an oversized file: the caller answers 400/413 with the reason.
 */
/** Magic-byte signatures for the binary types on the allowlist. `null` = a
 * text type (checked for NUL bytes instead) and `false` = no signature known. */
const MAGIC: Record<string, ((b: Uint8Array) => boolean) | null> = {
  ".png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  ".jpg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  ".jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  ".gif": (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  ".webp": (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && ascii(b, 8, 12) === "WEBP",
  ".bmp": (b) => b[0] === 0x42 && b[1] === 0x4d,
  ".avif": (b) => ascii(b, 4, 8) === "ftyp",
  ".pdf": (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
  ".zip": (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7),
  ".mp3": (b) => ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0), // ID3 tag or an MPEG frame sync
  ".wav": (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && ascii(b, 8, 12) === "WAVE",
  ".ogg": (b) => b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53,
  ".m4a": (b) => ascii(b, 4, 8) === "ftyp",
  ".mp4": (b) => ascii(b, 4, 8) === "ftyp",
  ".webm": (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
  ".txt": null,
  ".md": null,
  ".csv": null,
  ".json": null,
  ".log": null,
};

function ascii(b: Uint8Array, from: number, to: number): string {
  let out = "";
  for (let i = from; i < to && i < b.length; i += 1) out += String.fromCharCode(b[i]!);
  return out;
}

/**
 * The declared type must look like the bytes. An upload is untrusted input:
 * an `evil.png` that is really HTML (or a polyglot PDF/JS) is refused here,
 * so what `/api/attachments/:id` serves always matches its Content-Type
 * (which, with `nosniff`, is the browser's only truth).
 */
export function sniffMatches(ext: string, bytes: Uint8Array): boolean {
  const check = MAGIC[ext];
  if (check === undefined) return false;
  const head = bytes.subarray(0, 4096);
  if (check === null) return !head.includes(0); // a text type never carries NUL
  return check(head);
}

export function saveAttachment(name: string, bytes: Uint8Array): Attachment {
  const clean = safeName(name);
  const ext = extname(clean).toLowerCase();
  const mime = TYPES[ext];
  if (!mime) throw new AttachError(`tipo de archivo no aceptado (${ext || "sin extensión"}). Aceptados: ${ATTACH_ACCEPT}`);
  if (!bytes.length) throw new AttachError("el archivo está vacío");
  if (bytes.length > ATTACH_MAX_BYTES) throw new AttachError(`el archivo pasa de ${Math.round(ATTACH_MAX_BYTES / 1024 / 1024)} MB`, 413);
  if (!sniffMatches(ext, bytes)) throw new AttachError(`el contenido no es un ${ext} válido`, 400);
  return write(clean, ext, mime, bytes);
}

function write(clean: string, ext: string, mime: string, bytes: Uint8Array): Attachment {
  const id = randomBytes(8).toString("hex");
  const path = join(monthDir(), `${id}${ext}`);
  writeFileSync(path, bytes);
  const att: Attachment = { id, name: clean, mime, size: bytes.length, path, url: `/api/attachments/${id}` };
  appendFileSync(index_path(), `${JSON.stringify({ id, name: clean, mime, size: bytes.length, path, at: Date.now() })}\n`);
  indexLoaded = true;
  byId.set(id, att);
  return att;
}

/**
 * Register a file that already exists on this machine (an image the agent
 * produced in its workspace) so the browser can render it. The file is copied
 * into the store — the workspace is disposable, the attachment is not — and
 * repeated calls for the same unchanged file reuse the copy.
 */
export function registerFile(absPath: string): Attachment | null {
  const ext = extname(absPath).toLowerCase();
  const mime = TYPES[ext];
  if (!mime || !ext) return null;
  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || !stat.size || stat.size > ATTACH_MAX_BYTES) return null;
  loadIndex();
  try {
    const head = new Uint8Array(stat.size > 4096 ? 4096 : stat.size);
    const fd = openSync(absPath, "r");
    try { readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
    if (!sniffMatches(ext, head)) return null;
  } catch {
    return null;
  }
  const cached = registerCache.get(absPath);
  if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs && getAttachment(cached.id)) return byId.get(cached.id)!;
  const id = randomBytes(8).toString("hex");
  const path = join(monthDir(), `${id}${ext}`);
  try {
    copyFileSync(absPath, path);
  } catch {
    return null;
  }
  const att: Attachment = { id, name: absPath.split("/").pop() || `file${ext}`, mime, size: stat.size, path, url: `/api/attachments/${id}` };
  appendFileSync(index_path(), `${JSON.stringify({ id, name: att.name, mime, size: att.size, path, source: absPath, at: Date.now() })}\n`);
  byId.set(id, att);
  registerCache.set(absPath, { id, size: stat.size, mtime: stat.mtimeMs });
  return att;
}
const registerCache = new Map<string, { id: string; size: number; mtime: number }>();

/**
 * The block appended to the task text the agent sees, so it knows what was
 * attached: original name, type, size, where the file lives on disk and how
 * the browser serves it back. `collapseSkillPrompt` strips it from the
 * transcript, exactly as it strips the skills block.
 */
export function attachmentAgentBlock(atts: Attachment[]): string {
  return `<attachments>\n${atts
    .map((a) => `- ${a.name} — ${a.mime}, ${a.size} bytes — guardado en ${a.path} (el navegador lo descarga de ${a.url})`)
    .join("\n")}\n</attachments>`;
}

/**
 * The transcript's structured view of one prompt's files. Audio carries a
 * `kind` so the web can play it back instead of offering a download link.
 *
 * `.webm` is a shared container for audio and video and the allowlist has to
 * serve one stored mime for it. A take recorded in the browser is audio-only
 * and is named `nota-de-voz-*.webm`, so the name is what tells the two apart —
 * without this a recorded voice note would be classified as video and never
 * get a player.
 */
export function transcriptAttachment(a: Attachment): { id: string; kind: string; mime: string | null; url: string | null; name: string } {
  const recordedVoice = /^nota-de-voz-.*\.webm$/i.test(a.name);
  const kind = a.mime.startsWith("audio/") || recordedVoice ? "audio" : a.mime.startsWith("image/") ? "image" : "file";
  return { id: a.id, kind, mime: a.mime, url: a.url, name: a.name };
}

/** The transcript view: images inline (lightbox does the rest), other files as download links. */
export function attachmentLinksLine(atts: Attachment[]): string {
  return atts.map((a) => (a.mime.startsWith("image/") ? `![${a.name}](${a.url})` : `[${a.name}](${a.url})`)).join(" · ");
}

export { inlineWorkspaceImages };

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

/** One image reference found in agent text → a served attachment, or null. */
function imageAttachment(src: string, cwd: string): Attachment | null {
  let p = src;
  if (p.startsWith("file://")) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      return null;
    }
  }
  try {
    p = p.startsWith("/") ? decodeURIComponent(p) : join(cwd, decodeURIComponent(p));
  } catch {
    return null;
  }
  if (!IMAGE_EXT.test(p)) return null;
  return registerFile(p);
}

/**
 * Images the agent produced (or received) referenced by path in its text become
 * inline, served images: `![alt](/abs/path.png)` and bare `/abs/path.png` turn
 * into `![alt](/api/attachments/:id)`. Only files that really exist and pass
 * the allowlist are rewritten; everything else keeps its original text.
 */
function inlineWorkspaceImages(text: string, cwd: string): string {
  if (!text || !text.includes("/") || !cwd) return text;
  let changed = false;
  let out = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (whole, alt: string, src: string) => {
    const att = imageAttachment(src, cwd);
    if (!att) return whole;
    changed = true;
    return `![${alt}](${att.url})`;
  });
  // Bare absolute paths, one per line position — never inside `code` spans,
  // where the path may be quoted as an example rather than produced.
  out = out
    .split("\n")
    .map((line) => {
      if (line.includes("`") || !line.includes("/")) return line;
      return line.replace(
        /(^|[\s(])(\/[\w.@+-]+(?:\/[\w.@+-]+)+\.(?:png|jpe?g|gif|webp|bmp|avif))(?=$|[\s).,;:!?])/g,
        (whole, pre: string, p: string) => {
          const att = imageAttachment(p, cwd);
          if (!att) return whole;
          changed = true;
          return `${pre}![${att.name}](${att.url})`;
        },
      );
    })
    .join("\n");
  return changed ? out : text;
}
