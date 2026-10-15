/**
 * Bounded media handling for accepted channel attachments.
 *
 * Download path: every fetch is keyed by the attachment's stored providerRef
 * (the WhatsApp stanza id) plus the accepted thread — the evo-weai
 * getBase64FromMediaMessage route resolves the media itself, so no inbound
 * body can ever point this code at an arbitrary URL. Responses are size-capped
 * before decoding finishes.
 *
 * Storage: one 0600 file per attachment (identity = accepted inbox seq +
 * attachment id), inside a 0600 directory with a total-size bound. The owner
 * of cleanup is the consumer: sweep() runs at startup and periodically;
 * entries older than `retainMs` are deleted. Nothing here trusts message
 * content: a stored file is data, never a grant.
 */

import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface EvoMediaClient {
  /** Fetch media for an accepted attachment. Throws on any unbounded or failed response. */
  fetchMedia(args: { providerRef: string; thread: string }): Promise<{ bytes: Buffer; mime: string | null }>;
}

export function createEvoMediaClient(config: {
  baseUrl: string;
  instance: string;
  token: string;
  timeoutMs?: number;
  /** Hard cap on decoded bytes; larger media is refused, never truncated. */
  maxBytes?: number;
}): EvoMediaClient {
  const base = config.baseUrl.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? 30_000;
  const maxBytes = config.maxBytes ?? 20 * 1024 * 1024;
  return {
    async fetchMedia({ providerRef, thread }) {
      let response: Response;
      try {
        // Keyed ONLY by the stored provider reference and the accepted route.
        response = await fetch(`${base}/chat/getBase64FromMediaMessage/${encodeURIComponent(config.instance)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: config.token },
          body: JSON.stringify({ message: { key: { id: providerRef, remoteJid: thread, fromMe: false } } }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new Error(`media fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.status !== 200) throw new Error(`media fetch status ${response.status}`);
      let json: any = null;
      try {
        json = await response.json();
      } catch {
        throw new Error("media fetch returned non-JSON");
      }
      // Shapes seen across evo builds: {base64: "..."} and
      // {base64: {base64: "...", mimetype: "..."}}. Anything else is refused.
      const payload = typeof json?.base64 === "string" ? { data: json.base64, mime: typeof json?.mimetype === "string" ? json.mimetype : null } : typeof json?.base64?.base64 === "string" ? { data: json.base64.base64, mime: typeof json.base64.mimetype === "string" ? json.base64.mimetype : null } : null;
      if (!payload || payload.data.length === 0) throw new Error("media fetch response has no payload");
      // Cap on the encoded length BEFORE base64-decoding a huge string.
      if (payload.data.length > Math.ceil(maxBytes / 3) * 4 + 4) throw new Error(`media exceeds ${maxBytes} byte cap`);
      let bytes: Buffer;
      try {
        bytes = Buffer.from(payload.data, "base64");
      } catch {
        throw new Error("media payload is not valid base64");
      }
      if (bytes.length === 0) throw new Error("media payload decoded to zero bytes");
      if (bytes.length > maxBytes) throw new Error(`media exceeds ${maxBytes} byte cap`);
      return { bytes, mime: payload.mime };
    },
  };
}

const sanitize = (part: string) => part.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);

const EXTENSIONS: Record<string, string> = {
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
};

/** 0600 media store with identity, a per-file cap, a total-size bound and
 * expiry cleanup owned by the consumer. */
export class MediaStore {
  readonly dir: string;
  private readonly maxDirBytes: number;
  private readonly retainMs: number;
  constructor(dir: string, options?: { maxDirBytes?: number; retainMs?: number }) {
    this.dir = dir;
    this.maxDirBytes = options?.maxDirBytes ?? 256 * 1024 * 1024;
    this.retainMs = options?.retainMs ?? 7 * 24 * 60 * 60 * 1000;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  /** Persist one attachment's bytes under its accepted identity. */
  save(seq: number, attachmentId: string, bytes: Buffer, mime: string | null): string {
    const ext = (mime && EXTENSIONS[mime.split(";")[0].trim()]) || "";
    const path = join(this.dir, `seq${seq}-${sanitize(attachmentId)}${ext}`);
    if (this.totalBytes() + bytes.length > this.maxDirBytes) throw new Error(`media store full (cap ${this.maxDirBytes} bytes); sweep or raise the cap`);
    // Write via a private temp file so a crash never leaves a world-readable partial.
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, bytes, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    rmSync(path, { force: true });
    renameSync(tmp, path);
    return path;
  }
  has(seq: number, attachmentId: string): boolean {
    return this.find(seq, attachmentId) !== null;
  }
  /** The stored path for one attachment, when its bytes are here. */
  find(seq: number, attachmentId: string): string | null {
    const prefix = `seq${seq}-${sanitize(attachmentId)}`;
    try {
      const name = readdirSync(this.dir).find((f) => f.startsWith(prefix) && !f.includes(".tmp-"));
      return name ? join(this.dir, name) : null;
    } catch {
      return null;
    }
  }
  /** Deletes expired entries first, then — if still over the size bound — the
   * oldest files. Returns how many files were removed. */
  sweep(now = Date.now()): number {
    let removed = 0;
    let entries: Array<{ name: string; path: string; mtime: number; size: number }> = [];
    try {
      entries = readdirSync(this.dir)
        .map((name) => {
          const path = join(this.dir, name);
          try {
            const st = statSync(path);
            return { name, path, mtime: st.mtimeMs, size: st.size };
          } catch {
            return null;
          }
        })
        .filter((e): e is { name: string; path: string; mtime: number; size: number } => e !== null);
    } catch {
      return 0;
    }
    // Orphaned temp files (crash mid-write) count toward the total but are
    // never real media: delete them after an hour so they cannot wedge save().
    for (const e of entries) {
      if (e.name.includes(".tmp-")) {
        if (now - e.mtime > 3_600_000) {
          try {
            rmSync(e.path);
            removed++;
          } catch {}
        }
        continue;
      }
      if (now - e.mtime > this.retainMs) {
        try {
          rmSync(e.path);
          removed++;
        } catch {}
      }
    }
    const remaining = entries.filter((e) => !e.name.includes(".tmp-") && now - e.mtime <= this.retainMs);
    let total = remaining.reduce((sum, e) => sum + e.size, 0);
    for (const e of remaining.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= this.maxDirBytes) break;
      try {
        rmSync(e.path);
        total -= e.size;
        removed++;
      } catch {}
    }
    return removed;
  }
  totalBytes(): number {
    try {
      return readdirSync(this.dir).reduce((sum, f) => {
        try {
          return sum + statSync(join(this.dir, f)).size;
        } catch {
          return sum;
        }
      }, 0);
    } catch {
      return 0;
    }
  }
}
