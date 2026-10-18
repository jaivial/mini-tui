/**
 * Files attached from the prompt bar.
 *
 * A file is uploaded the moment it is picked (not when the message is sent), so
 * the send itself stays a small JSON call and a slow upload never blocks typing.
 * The server stores the bytes locally (`~/.local/share/mini-tui/attachments`)
 * and hands back an opaque id; only that id travels with the prompt, and the
 * agent's context gets the file's path plus its served URL.
 */

export interface AttachmentRef {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

/** What the server enforces; the picker and the size check mirror it. */
export const ATTACH_MAX = 15 * 1024 * 1024;
export const ATTACH_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.bmp,.avif,.pdf,.txt,.md,.csv,.json,.log,.mp3,.wav,.ogg,.m4a,.mp4,.webm,.zip";

/**
 * Upload one file. Throws with the server's reason (type, size, IO).
 *
 * E39: `signal` is wired because this is the one web request that WRITES -- a bare
 * `fetch` here could not be cancelled and had no deadline, so a stalled upload pinned
 * `canSend` false with no button to press (measured: Send still disabled at t+42 s, and
 * the answer landing after the user had moved on attached the file to the NEXT message).
 * The caller owns cancellation; see `attachmentUpload.ts`.
 */
export async function uploadAttachment(file: File, signal?: AbortSignal): Promise<AttachmentRef> {
  if (file.size > ATTACH_MAX) throw new Error(`${file.name}: pasa de ${Math.round(ATTACH_MAX / 1024 / 1024)} MB`);
  if (!file.size) throw new Error(`${file.name}: el archivo está vacío`);
  const body = new FormData();
  body.append("file", file, file.name);
  const res = await fetch("/api/attachments", { method: "POST", body, signal });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = await res.json();
      if (parsed?.error) message = parsed.error;
    } catch {
      // keep the status line
    }
    throw new Error(`${file.name}: ${message}`);
  }
  const saved = (await res.json()) as AttachmentRef;
  return { id: saved.id, name: saved.name || file.name, mime: saved.mime, size: saved.size, url: saved.url };
}

/** `1.2 MB` — the unit a person compares against their own files. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
