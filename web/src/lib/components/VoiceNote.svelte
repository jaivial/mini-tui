<!--
  A voice note in the transcript: one control, five states, no autoplay.

  Built on control-ui.dev's own audio pieces — the waveform is the ported
  `AudioVisualizer` (same `data-control-family` anatomy and recipe CSS) and
  the level readout uses Control UI's `level-meter` ballistics and dBFS scale.
  Control UI ships no player of its own (its audio family is the recorder, the
  visualizer, the level meter and the device select), so the play/pause control
  and the state machine here are this app's — and they are deliberately small:
  the note only ever moves because a person pressed play.
-->
<script lang="ts">
  import { Play, Pause, RotateCcw, TriangleAlert } from "@lucide/svelte";
  import AudioVisualizer from "./control-ui/AudioVisualizer.svelte";
  import {
    formatAudioRecorderDuration,
    levelMeterFraction,
    subscribeVoiceNote,
    toggleVoiceNote,
    VOICE_SCALE,
    type VoiceNoteStatus,
  } from "../audio/voicePlayback";

  let { url, name = "nota de voz" }: { url: string; name?: string } = $props();

  let status = $state<VoiceNoteStatus>({
    url,
    state: "idle",
    current: 0,
    duration: 0,
    progress: 0,
    error: null,
    levelDb: VOICE_SCALE.minDb,
    peakDb: VOICE_SCALE.minDb,
  });

  /** The latest snapshot the shared store handed us, applied one tick later. */
  let pending = $state<VoiceNoteStatus | null>(null);

  /**
   * Subscribe in an effect that writes NO state, and let the assignment below
   * live in its own effect. `subscribeVoiceNote` calls the subscriber
   * synchronously on subscribe; assigning inside the subscribing effect would
   * invalidate that very effect on every tick and Svelte would tear the
   * component down (`effect_update_depth_exceeded`).
   */
  $effect(() => subscribeVoiceNote((next) => {
    // The store is shared by every note on screen; only follow my own URL.
    if (next.url === url) pending = next;
  }));

  $effect(() => {
    if (pending && pending.url === url) status = pending;
  });

  const playing = $derived(status.state === "playing");
  const busy = $derived(status.state === "loading");
  const failed = $derived(status.state === "error");

  /**
   * The waveform is the note's own amplitude, sampled once and reused: a real
   * time-domain tap would mean decoding the whole file twice (once for the
   * meter, once for the bars) and would still be an estimate. So the bars show
   * the position instead, and the level meter carries the live signal — the
   * split Control UI's own kits make.
   */
  const BARS = 28;
  const levels = $derived(
    Array.from({ length: BARS }, (_, i) => {
      // A fixed silhouette, dimmed ahead of the playhead and lit behind it.
      const shape = 0.25 + 0.75 * Math.abs(Math.sin((i + 1) * 1.7));
      const played = i / BARS <= status.progress;
      return played ? shape : shape * 0.28;
    }),
  );

  const levelFraction = $derived(levelMeterFraction(status.levelDb, VOICE_SCALE));

  const elapsed = $derived(formatAudioRecorderDuration((status.current || 0) * 1000));
  const total = $derived(formatAudioRecorderDuration((status.duration || 0) * 1000));

  /** What a screen reader hears for the button, and what it says while busy. */
  const actionLabel = $derived(
    playing
      ? `Pausar ${name}`
      : status.current > 0
        ? `Reanudar ${name}, ${elapsed} reproducidas`
        : `Reproducir ${name}${status.duration ? `, ${total}` : ""}`,
  );

  const statusText = $derived(
    failed
      ? (status.error ?? "No se pudo reproducir")
      : playing
        ? `Reproduciendo ${name}: ${elapsed} de ${total}`
        : status.current > 0
          ? `En pausa: ${elapsed} de ${total}`
          : status.duration
            ? `${name}, duración ${total}`
            : name,
  );

  function toggle() {
    void toggleVoiceNote(url);
  }

  function onkeydown(event: KeyboardEvent) {
    // Space/Enter already activate a <button>; this only adds the shortcuts a
    // media player is expected to have, and never fires while typing elsewhere.
    if (event.target !== event.currentTarget) return;
    if (event.key === " " || event.key === "k") {
      event.preventDefault();
      toggle();
    }
  }
</script>

<!-- Playback never starts on its own. Scrolling a note into view does not touch
     it (no IntersectionObserver, no autoplay attribute), and leaving the page
     stops whatever is sounding. -->
<div
  class="flex min-w-0 max-w-full items-center gap-2 rounded-xl border border-line/70 bg-canvas/70 py-1 pr-1 pl-1.5"
  data-state={status.state}
>
  <button
    type="button"
    class="interactive relative grid size-11 shrink-0 cursor-pointer place-items-center rounded-full bg-brand text-brand-ink
      hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
    aria-label={actionLabel}
    title={actionLabel}
    aria-keyshortcuts="Space K"
    disabled={busy}
    onclick={toggle}
    onkeydown={onkeydown}
  >
    {#if failed}
      <RotateCcw size={17} strokeWidth={2} aria-hidden="true" />
    {:else if playing}
      <Pause size={17} strokeWidth={2} aria-hidden="true" />
    {:else}
      <Play size={17} strokeWidth={2} class="translate-x-px" aria-hidden="true" />
    {/if}
    {#if busy}
      <span class="absolute inset-0 grid place-items-center" aria-hidden="true">
        <span class="size-4 animate-spin rounded-full border-[1.5px] border-brand-ink/40 border-t-brand-ink"></span>
      </span>
    {/if}
  </button>

  <div class="flex min-w-0 flex-1 flex-col gap-0.5">
    <AudioVisualizer
      {levels}
      active={playing || busy}
      points={BARS}
      class="h-6 w-full"
      aria-label={`Forma de onda de ${name}`}
    />
    <div class="flex items-center gap-1.5">
      <span class="tnum text-[11px] text-ink-muted">{playing || status.current > 0 ? elapsed : total || "—"}</span>
      <!-- Control UI's level meter as a plain hairline: the fill is the live
           dBFS reading, the tick is the 1s peak hold. -->
      <span class="relative h-1 flex-1 overflow-hidden rounded-full bg-raised" aria-hidden="true">
        <span
          class="absolute inset-y-0 left-0 rounded-full bg-ink-faint/70 transition-[width] duration-75"
          style:width={`${Math.round(levelFraction * 100)}%`}
        ></span>
        <span
          class="absolute inset-y-0 w-px bg-ink-muted/70 transition-[left] duration-75"
          style:left={`${Math.round(levelMeterFraction(status.peakDb, VOICE_SCALE) * 100)}%`}
        ></span>
      </span>
      {#if failed}
        <TriangleAlert size={12} strokeWidth={2} class="shrink-0 text-err" aria-hidden="true" />
      {/if}
    </div>
  </div>

  <!-- The state is announced, not merely coloured. -->
  <span class="sr-only" role="status" aria-live="polite">{statusText}</span>
</div>
