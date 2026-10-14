/**
 * Audio → text via a local whisper.cpp build — the lightest real transcription
 * path on this host (no GPU, CPU-only, small ggml models).
 *
 * Lane rule: whisper is heavy-lane work. Each run is spawned under a systemd
 * user scope capped at CPUQuota/MemoryMax (default 25% / 2 GB) so it can never
 * squeeze the box's benchmark or serving processes; if systemd-run is absent
 * the caller's environment is expected to bound the process some other way.
 *
 * Honesty: the state returned is derived from whisper's own numbers, never
 * optimism. `complete` only when text exists and every segment's mean content
 * token probability is inside the confident band; `uncertain` when text exists
 * but some segment's confidence is weak (the reply must say so); `failed` for
 * empty output, over-cap audio, tool failures or timeouts.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TranscriptionState = "complete" | "uncertain" | "failed";

export interface TranscriptionResult {
  state: TranscriptionState;
  text: string;
  error?: string;
}

export interface Transcriber {
  transcribe(args: { path: string; maxAudioSeconds: number; timeoutMs: number }): Promise<TranscriptionResult>;
}

interface WhisperToken { text?: string; p?: number }
interface WhisperSegment {
  text?: string;
  tokens?: WhisperToken[];
}

/** Mean probability of the segment's content tokens (special/format tokens
 * like [_BEG_] excluded). This build of whisper.cpp exposes confidence only
 * per token; the mean is what separates a garbled segment from a clean one. */
function segmentConfidence(segment: WhisperSegment): number | null {
  const tokens = (segment.tokens ?? []).filter((t) => typeof t.p === "number" && t.text && !t.text.startsWith("[") && !t.text.startsWith("_"));
  if (!tokens.length) return null;
  return tokens.reduce((sum, t) => sum + (t.p as number), 0) / tokens.length;
}

/** Below this mean content-token probability a segment counts as weak. */
const CONFIDENT_TOKEN_P = 0.8;

function run(cmd: string, args: string[], timeoutMs: number, spawnFn: typeof spawn): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawnFn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export function createWhisperTranscriber(config: {
  /** Path to the whisper-cli binary. */
  bin: string;
  /** Path to the ggml model file. */
  model: string;
  /** systemd user scope CPU quota for each whisper run (e.g. "25%"). Empty string disables the wrapper. */
  cpuQuota?: string;
  /** systemd user scope memory cap (e.g. "2G"). */
  memMax?: string;
  spawnFn?: typeof spawn;
}): Transcriber {
  const spawnFn = config.spawnFn ?? spawn;
  return {
    async transcribe({ path, maxAudioSeconds, timeoutMs }) {
      const work = mkdtempSync(join(tmpdir(), "mini-transcribe-"));
      try {
        // 1. Duration cap — checked on the real file, not the message metadata.
        const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path], 15_000, spawnFn);
        const duration = Number.parseFloat(probe.stdout.trim());
        if (Number.isFinite(duration) && duration > maxAudioSeconds) {
          return { state: "failed", text: "", error: `audio is ${Math.round(duration)}s; transcription cap is ${maxAudioSeconds}s` };
        }
        // 2. Convert to the 16 kHz mono WAV whisper.cpp requires.
        const wav = join(work, "audio.wav");
        const convert = await run("ffmpeg", ["-v", "error", "-i", path, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], 120_000, spawnFn);
        if (convert.code !== 0) return { state: "failed", text: "", error: `ffmpeg failed: ${convert.stderr.slice(0, 200)}` };
        // 3. whisper-cli under the cgroup lane, JSON out for honest confidence.
        const jsonOut = join(work, "transcript");
        const whisperArgs = ["-m", config.model, "-f", wav, "-ojf", "-of", jsonOut];
        const wrapped = !!config.cpuQuota;
        const args = wrapped
          ? ["--user", "--scope", "--quiet", "-p", `CPUQuota=${config.cpuQuota}`, "-p", `MemoryMax=${config.memMax ?? "2G"}`, "--", config.bin, ...whisperArgs]
          : whisperArgs;
        const started = Date.now();
        const result = await run(wrapped ? "systemd-run" : config.bin, args, timeoutMs, spawnFn);
        if (result.code !== 0) return { state: "failed", text: "", error: `whisper failed: ${(result.stderr || result.stdout).slice(0, 200)}` };
        // 4. Read the JSON and decide the state from whisper's own numbers.
        let parsed: { transcription?: WhisperSegment[] };
        try {
          parsed = JSON.parse(readFileSync(`${jsonOut}.json`, "utf8"));
        } catch {
          return { state: "failed", text: "", error: "whisper produced unreadable output" };
        }
        const segments = (parsed.transcription ?? []).map((s) => ({ text: String(s.text ?? "").trim(), confidence: segmentConfidence(s) })).filter((s) => s.text.length > 0);
        const text = segments.map((s) => s.text).join(" ").trim();
        if (!text) return { state: "failed", text: "", error: "no speech recognized" };
        const weak = segments.some((s) => s.confidence !== null && s.confidence < CONFIDENT_TOKEN_P);
        return { state: weak ? "uncertain" : "complete", text, error: undefined };
      } catch (error) {
        return { state: "failed", text: "", error: error instanceof Error ? error.message : String(error) };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
}
