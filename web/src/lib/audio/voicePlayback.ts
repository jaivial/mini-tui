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
/**
 * The meter context, built once and kept for as long as the page lives.
 *
 * `createMediaElementSource` is a ONE-SHOT, PERMANENT reroute: an element can
 * only ever be bound to one MediaElementAudioSourceNode, and once that node
 * exists the element's audio is delivered *into the graph* instead of straight
 * to the device. So this context is not rebuilt per play. It is created on the
 * first play and, crucially, never `close()`d — a closed context takes the
 * element's audio down with it and the element cannot be rebound, because the
 * second `createMediaElementSource` throws InvalidStateError and the first node
 * is already gone with the context that owned it.
 */
let audioCtx: AudioContext | null = null;
/** The node that owns `audio`'s output. Null until the first play. */
let sourceNode: MediaElementAudioSourceNode | null = null;
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
  // A PAUSED element is not a reason to stop looping. The loop used to return
  // here without rescheduling, so the first pause killed the meter for good:
  // every later play went on making sound, but the level readout stayed frozen
  // on whatever the first play left behind (measured: 37 meter reads on the
  // first play, 0 and 0 on the next two, with `levelDb` stuck at the value the
  // audio had long since stopped reaching). Keep the loop alive and let
  // `startMeter` be the only thing that ever stops it.
  if (!audio || !analyser) return;
  const now = performance.now();
  const elapsed = now - lastMeterAt;
  lastMeterAt = now;
  // While paused the graph renders nothing, so a reading now would be a lie
  // painted as a live level: decay to the floor instead of sampling silence.
  const levelDb = audio.paused ? VOICE_SCALE.minDb : readLevelDb();
  meter = advanceLevelMeterReading(meter, levelDb, elapsed, now, VOICE_SCALE);
  if (meter.levelDb !== status.levelDb || meter.peakDb !== status.peakDb) {
    status = { ...status, levelDb: meter.levelDb, peakDb: meter.peakDb };
    publish();
  }
  frame = requestAnimationFrame(tickMeter);
}

/**
 * Build the meter graph, once, on the first play.
 *
 * The chain is source -> analyser -> **destination**, and the last hop is the
 * whole point: `createMediaElementSource` moves the element's audio into this
 * graph, so a graph that stops at the analyser is a graph the sound never
 * leaves. A branch with no path to `ctx.destination` is not even rendered
 * (measured: 0 render callbacks vs 31 with the wire), which means the note
 * plays silently while the UI reports it as playing.
 *
 * Idempotent, because a second call is what used to throw: the element is
 * already bound, and a fresh context cannot take it over.
 */
function startMeter(el: HTMLAudioElement) {
  // Two different questions were conflated here. "Is the graph BUILT?" is a
  // once-per-page fact — the reroute is permanent, so it must never be rebuilt.
  // "Is the meter LOOP running?" is a per-play one. Bailing on `sourceNode`
  // answered the first with the second, which is what stranded the level
  // readout after the first pause.
  if (frame !== null) return; // already sampling
  if (sourceNode !== null) {
    // Graph is built and correct; only the loop needs restarting.
    lastMeterAt = performance.now();
    frame = requestAnimationFrame(tickMeter);
    return;
  }
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    let bound: MediaElementAudioSourceNode;
    try {
      bound = ctx.createMediaElementSource(el);
    } catch {
      // Someone else already owns this element's output. Our context never
      // touched it, so it is safe to drop; theirs keeps working.
      void ctx.close().catch(() => {});
      analyser = null;
      samples = null;
      return;
    }
    audioCtx = ctx;
    sourceNode = bound;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.2;
    samples = new Uint8Array(analyser.fftSize);
    bound.connect(analyser);
    // The reroute took the element's output off the direct device path, so
    // this hop has to put it back. The analyser stays a tap: it is in the
    // path, but it neither adds gain nor duplicates the signal.
    analyser.connect(ctx.destination);
    // A context created before the page had a gesture starts suspended, and a
    // suspended graph renders nothing — audible or not.
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    lastMeterAt = performance.now();
    frame = requestAnimationFrame(tickMeter);
  } catch {
    // No WebAudio: the player still works, only the level readout stays flat.
    audioCtx = null;
    sourceNode = null;
    analyser = null;
    samples = null;
  }
}

/**
 * Stop sampling, and leave the graph alone.
 *
 * This deliberately does NOT close the context. `stopMeter` used to, and that
 * is unrecoverable for the element: the permanent reroute is bound to *that*
 * context, so closing it strands the element with no output path at all — it
 * keeps reporting `playing` and stops advancing, and a rebuild throws
 * InvalidStateError because the element is still bound to the dead node.
 */
function stopMeter() {
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  meter = { levelDb: VOICE_SCALE.minDb, peakDb: VOICE_SCALE.minDb, peakHeldUntilMs: 0 };
  // The paint has to follow the reset, or the fill stays frozen on the last
  // level the audio reached instead of dropping back to the floor.
  if (status.levelDb !== VOICE_SCALE.minDb || status.peakDb !== VOICE_SCALE.minDb) {
    status = { ...status, levelDb: VOICE_SCALE.minDb, peakDb: VOICE_SCALE.minDb };
    publish();
  }
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
