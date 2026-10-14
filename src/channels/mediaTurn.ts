/**
 * Attachment handling inside the consumer turn path.
 *
 * Rules (WA-4):
 *  - Audio: bounded download → local whisper transcription → ChannelInbox
 *    .transcript(seq, attachmentId, text, state). The transcript stays
 *    attached to the ORIGINAL message; transcript() also writes the durable
 *    channel_updates row, so an already-acknowledged message still receives
 *    its late transcript. The turn prompt frames the transcript as data.
 *  - Images: this session path (runHeadless) has no image payload support, so
 *    the honest move is a refusal frame — the session is told it cannot see
 *    the image and must say so. No OCR, no ASCII probing, no fabrication.
 *  - Documents: bounded download + 0600 retention with expiry; text extraction
 *    only when a real extractor exists (none wired yet → honest refusal).
 *  - Nothing here ever throws into the turn loop: every failure becomes an
 *    honest frame the session can relay, or a pending state the late sweep
 *    retries.
 */

import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Inbound, Attachment } from "./inbox";
import type { EvoMediaClient, MediaStore } from "./evoMedia";
import type { Transcriber } from "./transcribe";
import type { Database } from "bun:sqlite";

export interface MediaHandling {
  client: EvoMediaClient | null;
  store: MediaStore | null;
  transcriber: Transcriber | null;
  maxAudioSeconds: number;
  transcribeTimeoutMs: number;
  /** How often the late-transcript/media sweep runs while idle (0 = never). */
  lateSweepMs: number;
}

/** Durable idempotency for the follow-up note sent when a late transcript
 * completes. Keyed by the accepted identity, never by message content. */
export class LateTranscriptLog {
  readonly db: Database;
  constructor(db: Database) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS channel_late_transcripts(seq INTEGER NOT NULL,attachment_id TEXT NOT NULL,delivered_at INTEGER NOT NULL,PRIMARY KEY(seq,attachment_id))`);
  }
  delivered(seq: number, attachmentId: string): boolean {
    return !!this.db.query("SELECT 1 FROM channel_late_transcripts WHERE seq=?1 AND attachment_id=?2").get(seq, attachmentId);
  }
  mark(seq: number, attachmentId: string): void {
    this.db.query("INSERT OR IGNORE INTO channel_late_transcripts(seq,attachment_id,delivered_at) VALUES(?1,?2,?3)").run(seq, attachmentId, Date.now());
  }
}

const mimeLabel = (a: Attachment) => a.mime ?? "unknown type";

/** True if the attachment can still be fetched/transcribed later. */
export function isRetryableAudio(a: Attachment): boolean {
  return a.kind === "audio" && a.transcriptionState === "pending";
}

/** Fetch, store, transcribe and write the transcript for one pending audio
 * attachment. Returns the prompt frame plus the definitive outcome when one
 * was reached (the late-transcript sweep uses it for the follow-up note).
 * Transient fetch failures leave the attachment pending (the late sweep
 * retries); only definitive outcomes — success, weak confidence, no speech,
 * over-cap — resolve the state. */
export async function transcribePendingAudio(
  media: MediaHandling,
  inbox: { transcript(seq: number, attachmentId: string, text: string, state: "complete" | "uncertain" | "failed"): void },
  log: (event: string, fields?: Record<string, unknown>) => void,
  seq: number,
  attachment: Attachment,
  thread: string,
): Promise<{ frame: string; outcome?: { state: "complete" | "uncertain" | "failed"; text: string; error?: string } }> {
  if (!media.client || !media.store || !media.transcriber) {
    return { frame: "[Voice note attached. Transcription is temporarily unavailable — say honestly that the voice note cannot be played or read yet.]" };
  }
  let path: string | null = findStoredPath(media.store, seq, attachment.id);
  let tempDir: string | null = null;
  if (!path) {
    if (!attachment.providerRef) return { frame: "[Voice note attached but unusable (missing provider reference). Say honestly it cannot be transcribed.]" };
    let bytes: Buffer | null = null;
    let mime: string | null = null;
    try {
      const fetched = await media.client.fetchMedia({ providerRef: attachment.providerRef, thread });
      bytes = fetched.bytes;
      mime = fetched.mime;
    } catch (error) {
      // Transport problem, not a verdict: stay pending, retry later.
      log("channel.media.fetch_failed", { seq, attachmentId: attachment.id, error: error instanceof Error ? error.message : String(error) });
      return { frame: "[Voice note attached. Transcription could not be fetched right now — say honestly it is not available yet.]" };
    }
    try {
      path = media.store.save(seq, attachment.id, bytes, mime ?? attachment.mime ?? null);
    } catch (error) {
      // Store full is a retention problem, not a transcription verdict: fall
      // back to a private temp dir (mkdtemp: unpredictable name, no collision)
      // so the honest outcome still gets reached. Removed after transcribing.
      log("channel.media.store_fallback", { seq, attachmentId: attachment.id, error: error instanceof Error ? error.message : String(error) });
      tempDir = mkdtempSync(join(tmpdir(), "mini-tui-media-"));
      chmodSync(tempDir, 0o700);
      path = join(tempDir, "media");
      writeFileSync(path, bytes, { mode: 0o600 });
    }
  }
  let result;
  try {
    result = await media.transcriber.transcribe({ path, maxAudioSeconds: media.maxAudioSeconds, timeoutMs: media.transcribeTimeoutMs });
  } finally {
    if (typeof tempDir === "string") rmSync(tempDir, { recursive: true, force: true });
  }
  if (result.transient) {
    log("channel.media.transient", { seq, attachmentId: attachment.id, error: result.error?.slice(0, 200) });
    return { frame: "[Voice note attached. Transcription is temporarily unavailable — say honestly it is not available right now.]" };
  }
  if (result.state === "failed") {
    // Definitive: no speech / over cap / tool failure. Record honestly.
    try {
      inbox.transcript(seq, attachment.id, "", "failed");
    } catch (error) {
      log("channel.media.transcript_write_failed", { seq, attachmentId: attachment.id, error: error instanceof Error ? error.message : String(error) });
    }
    log("channel.media.transcribe", { seq, attachmentId: attachment.id, state: "failed", error: result.error?.slice(0, 200) });
    return { frame: `[Voice note attached. Transcription failed: ${result.error ?? "unknown error"}. Say honestly that the voice note could not be transcribed.]`, outcome: result };
  }
  try {
    inbox.transcript(seq, attachment.id, result.text, result.state);
  } catch (error) {
    log("channel.media.transcript_write_failed", { seq, attachmentId: attachment.id, error: error instanceof Error ? error.message : String(error) });
  }
  log("channel.media.transcribe", { seq, attachmentId: attachment.id, state: result.state, chars: result.text.length });
  if (result.state === "uncertain") {
    return { frame: `[Voice note transcript — LOW CONFIDENCE, tell the sender the transcription may be imperfect]: "${result.text}"`, outcome: result };
  }
  return { frame: `[Voice note transcript]: "${result.text}"`, outcome: result };
}

function findStoredPath(store: MediaStore, seq: number, attachmentId: string): string | null {
  try {
    const prefix = `seq${seq}-${attachmentId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120)}`;
    const hit = readdirSync(store.dir).find((f) => f.startsWith(prefix) && !f.includes(".tmp-"));
    return hit ? `${store.dir}/${hit}` : null;
  } catch {
    return null;
  }
}

/** Build the media frames for a turn: resolve pending audio (download +
 * transcribe + durable transcript), frame images/documents honestly. */
export async function ensureMediaFrames(
  media: MediaHandling,
  inbox: { transcript(seq: number, attachmentId: string, text: string, state: "complete" | "uncertain" | "failed"): void },
  log: (event: string, fields?: Record<string, unknown>) => void,
  seq: number,
  message: Inbound,
): Promise<string[]> {
  const frames: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.kind === "audio") {
      if (attachment.transcriptionState === "pending") {
        frames.push((await transcribePendingAudio(media, inbox, log, seq, attachment, message.thread)).frame);
      } else if (attachment.transcriptionState === "complete") {
        frames.push(`[Voice note transcript]: "${attachment.transcript ?? ""}"`);
      } else if (attachment.transcriptionState === "uncertain") {
        frames.push(`[Voice note transcript — LOW CONFIDENCE, tell the sender the transcription may be imperfect]: "${attachment.transcript ?? ""}"`);
      } else {
        frames.push("[Voice note attached. Transcription failed earlier. Say honestly that the voice note could not be transcribed.]");
      }
    } else if (attachment.kind === "image") {
      frames.push(`[Image attached (${mimeLabel(attachment)}). This session cannot view images — no description is possible. If the sender expects a reaction to it, say honestly that images are not supported yet.]`);
    } else {
      // Document: bounded download + retention where possible; no extractor is
      // wired, so the honest answer is refusal, never a guessed summary.
      let storedNote = "";
      if (media.client && media.store && attachment.providerRef && !media.store.has(seq, attachment.id)) {
        try {
          const fetched = await media.client.fetchMedia({ providerRef: attachment.providerRef, thread: message.thread });
          media.store.save(seq, attachment.id, fetched.bytes, fetched.mime ?? attachment.mime ?? null);
          storedNote = " It is stored for later processing.";
        } catch (error) {
          log("channel.media.document_store_failed", { seq, attachmentId: attachment.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      frames.push(`[Document attached (${mimeLabel(attachment)})${message.text ? "" : ", with no caption"}.${storedNote} Text extraction is not supported yet — do not guess its contents; say honestly that documents cannot be read yet.]`);
    }
  }
  return frames;
}

/** The follow-up note sent to the thread when a transcript completes after the
 * message was already answered (late path via channel_updates). */
export function lateTranscriptNote(text: string, state: "complete" | "uncertain" | "failed", error?: string): string {
  if (state === "failed") return `(I could not transcribe your earlier voice note${error ? `: ${error}` : ""})`;
  const confidence = state === "uncertain" ? " — note: low confidence, it may contain errors" : "";
  return `(transcription of your earlier voice note${confidence}: "${text}")`;
}
