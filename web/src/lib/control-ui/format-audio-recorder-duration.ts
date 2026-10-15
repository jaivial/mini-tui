/**
 * Control UI — `format-audio-recorder-duration`
 *
 * Ported verbatim from control-ui.dev's registry source
 * (`src/registry/lib/format-audio-recorder-duration.ts`, registry item
 * `audio-recorder`, fetched 2026-10-15). MIT, © Damien Schneider.
 * https://control-ui.dev/kits/audio-recorder
 */

export function formatAudioRecorderDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}
