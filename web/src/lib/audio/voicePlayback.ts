/**
 * One `<audio>` element, kept outside the DOM, driven through a Svelte store.
 *
 * Voice notes are short and there is rarely more than one on screen, so a
 * single shared element beats one per bubble: the browser keeps the decoded
 * buffer warm, `play()` on a second note interrupts the first, and only one
 * thing can ever be playing. A component subscribes and tears its
 * subscription down on unmount; `pauseAll` is what stops playback when a note
 * scrolls out of view.
 */
import { formatAudioRecorderDuration } from "../control-ui/format-audio-recorder-duration";
import { advanceLevelMeterReading, levelMeterFraction, type LevelMeterReading, type LevelMeterRange } from "../control-ui/level-meter-ballistics";

/** dBFS window the meter paints, and the scale every reading is clamped to. */
export const VOICE_SCALE: LevelMeterRange = { minDb: -54, maxDb: -6 };

export type VoiceState = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

export type VoiceNoteStatus = {
  url: string;
  state: VoiceState;
  /** Seconds played, and how long the note is once the browser knows. */
  current: number;
  duration: number;
  /** 0..1 playback position, for the progress fill. */
  progress: number;
  error: string | null;
  levelDb: number;
  peakDb: number;
};

let audio: HTMLAudioElement | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let samples: Uint8Array<ArrayBuffer> | null = null;
let meter: LevelMeterReading = { levelDb: VOICE_SCALE.minDb, peakDb: VOICE_SCALE.minDb, peakHeldUntilMs: 0 };
let lastMeterAt = 0;
let frame: number | null = null;
let currentUrl = "";

const subscribers = new Set<(status: VoiceNoteStatus) => void>();

function blank(url: string): VoiceNoteStatus {
  return { url, state: "idle", current: 0, duration: 0, progress: 0, error: null, levelDb: VOICE_SCALE.minDb, peakDb: VOICE_SCALE.minDb };
}

let status: VoiceNoteStatus = blank("");

function publish() {
  for (const subscriber of subscribers) subscriber(status);
}

function ensureElement(): HTMLAudioElement {
  if (audio) return audio;
  const el = new Audio();
  el.preload = "metadata";
  // Never louder than the page: a transcript should not startle anyone.
  el.volume = 1;
  el.addEventListener("loadstart", () => setState("loading"));
  el.addEventListener("waiting", () => setState("loading"));
  el.addEventListener("playing", () => setState("playing"));
  el.addEventListener("pause", () => {
    if (el.ended) return;
    setState(el.currentTime > 0 ? "paused" : "idle");
  });
  el.addEventListener("ended", () => {
    setState("ended");
    stopMeter();
    el.currentTime = 0;
  });
  el.addEventListener("error", () => {
    stopMeter();
    setState("error", "No se pudo cargar esta nota de voz");
  });
  el.addEventListener("timeupdate", () => syncTime(el));
  el.addEventListener("loadedmetadata", () => syncTime(el));
  audio = el;
  return el;
}

function setState(next: VoiceState, error: string | null = null) {
  status = { ...status, state: next, error };
  publish();
}

function syncTime(el: HTMLAudioElement) {
  const duration = Number.isFinite(el.duration) ? el.duration : 0;
  const current = el.currentTime || 0;
  status = {
    ...status,
    current,
    duration,
    progress: duration > 0 ? Math.min(1, Math.max(0, current / duration)) : 0,
  };
  publish();
}

/** RMS of the analyser window, in dBFS, smoothed by Control UI's ballistics. */
function readLevelDb(): number {
  if (!analyser || !samples) return VOICE_SCALE.minDb;
  analyser.getByteTimeDomainData(samples);
  let total = 0;
  for (const value of samples) {
    const sample = (value - 128) / 128;
    total += sample * sample;
  }
  const rms = Math.sqrt(total / samples.length);
  return rms > 0 ? Math.max(VOICE_SCALE.minDb, 20 * Math.log10(rms)) : VOICE_SCALE.minDb;
}

function tickMeter() {
  frame = null;
  if (!audio || audio.paused) return;
  const now = performance.now();
  const elapsed = now - lastMeterAt;
  lastMeterAt = now;
  meter = advanceLevelMeterReading(meter, readLevelDb(), elapsed, now, VOICE_SCALE);
  if (meter.levelDb !== status.levelDb || meter.peakDb !== status.peakDb) {
    status = { ...status, levelDb: meter.levelDb, peakDb: meter.peakDb };
    publish();
  }
  frame = requestAnimationFrame(tickMeter);
}

function startMeter(el: HTMLAudioElement) {
  stopMeter();
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioCtx = new Ctor();
    const source = audioCtx.createMediaElementSource(el);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.2;
    samples = new Uint8Array(analyser.fftSize);
    source.connect(analyser);
    // The element's own output stays the only audible path: the analyser is a
    // tap, never a reroute, so nothing is doubled or muted.
    lastMeterAt = performance.now();
    frame = requestAnimationFrame(tickMeter);
  } catch {
    // No WebAudio (or a cross-origin source): the player still works, only the
    // level readout is flat.
    audioCtx = null;
    analyser = null;
    samples = null;
  }
}

function stopMeter() {
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  analyser = null;
  samples = null;
  void audioCtx?.close().catch(() => {});
  audioCtx = null;
  meter = { levelDb: VOICE_SCALE.minDb, peakDb: VOICE_SCALE.minDb, peakHeldUntilMs: 0 };
}

function load(url: string): HTMLAudioElement {
  const el = ensureElement();
  if (currentUrl !== url) {
    currentUrl = url;
    status = blank(url);
    el.src = url;
    el.load();
  }
  return el;
}

export function subscribeVoiceNote(subscriber: (status: VoiceNoteStatus) => void): () => void {
  subscribers.add(subscriber);
  subscriber(status);
  return () => {
    subscribers.delete(subscriber);
    // The last reader going away releases the element, so a closed tab is not
    // still holding a decoded note (and the mic-style "media session") alive.
    if (subscribers.size === 0) pauseAll();
  };
}

export async function toggleVoiceNote(url: string): Promise<void> {
  const el = load(url);
  if (!el.paused && currentUrl === url) {
    el.pause();
    return;
  }
  if (el.error) {
    // A failed load stays failed until it is asked for again.
    el.load();
  }
  try {
    await el.play();
    startMeter(el);
  } catch (error) {
    setState("error", error instanceof Error && error.name === "NotAllowedError" ? "El navegador bloqueó la reproducción" : "No se pudo reproducir esta nota de voz");
  }
}

export function pauseAll(): void {
  if (!audio) return;
  audio.pause();
  stopMeter();
  if (status.state === "playing" || status.state === "loading") setState(status.current > 0 ? "paused" : "idle");
}

/** Control UI's meter scale, re-exported so a caller can paint the same one. */
export { levelMeterFraction, formatAudioRecorderDuration };
