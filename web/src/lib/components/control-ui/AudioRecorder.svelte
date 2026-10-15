<!--
  Control UI — `AudioRecorder`

  Ported from control-ui.dev's registry source
  (`src/registry/sources/control-ui/audio-recorder.tsx`, registry item
  `audio-recorder`, fetched 2026-10-15). MIT, © Damien Schneider.
  https://control-ui.dev/kits/audio-recorder

  Control UI's own anatomy and contract:
    <AudioRecorder>
      <AudioRecorderTrigger /> <AudioRecorderStatus />
      <AudioRecorderVisualizer /> <AudioRecorderDuration />
      <AudioRecorderCancel /> <AudioRecorderSubmit />
    </AudioRecorder>
  flattened here into one pill-sized row, because this app puts it inside a
  composer that has no room for a six-slot kit — the slots, their
  `data-slot` names, the `data-state` machine (idle / requesting / recording /
  recorded / submitting / error), the reveal-then-hide transition and the
  control-ui recipe CSS are all Control UI's. The state machine itself runs in
  `../../control-ui/audio-recorder-controller.ts`, ported verbatim.

  Changed only for the host: React context → props, `cn` → template strings.
-->
<script lang="ts">
  import { Mic, Square, X, Check, RotateCcw } from "@lucide/svelte";
  import AudioVisualizer from "./AudioVisualizer.svelte";
  import { useAudioRecorder, type AudioRecording } from "../../control-ui/recorder.svelte";
  import { formatAudioRecorderDuration } from "../../control-ui/format-audio-recorder-duration";

  let {
    disabled = false,
    maxDurationMs = 5 * 60 * 1000,
    label = "Grabar nota de voz",
    onRecordingComplete,
    onCancel,
  }: {
    disabled?: boolean;
    maxDurationMs?: number;
    label?: string;
    onRecordingComplete?: (recording: AudioRecording) => void | Promise<void>;
    onCancel?: () => void;
  } = $props();

  // Read through a getter so the controller always calls the CURRENT handler:
  // reading the props directly here would capture the first one and leave every
  // later parent re-render sending to a stale closure.
  const recorder = useAudioRecorder({
    get disabled() {
      return disabled;
    },
    get maxDurationMs() {
      return maxDurationMs;
    },
    get onRecordingComplete() {
      return onRecordingComplete;
    },
    get onCancel() {
      return onCancel;
    },
  });

  const recording = $derived(recorder.recording);
  const live = $derived(recorder.state === "recording" || recorder.state === "requesting");
  const errored = $derived(recorder.state === "error");
  const sending = $derived(recorder.state === "submitting");

  // Control UI's `AudioRecorderStatus` wording, so a screen reader hears the
  // same sentence its component would announce.
  const status = $derived(
    recorder.state === "requesting"
      ? "Esperando permiso del micrófono"
      : recorder.state === "recording"
        ? "Grabando"
        : recorder.state === "recorded"
          ? "Nota de voz lista"
          : recorder.state === "submitting"
            ? "Enviando la nota de voz"
            : errored
              ? (recorder.error?.message ?? "No se pudo grabar")
              : "",
  );

  /** Stop early and hand the blob over; Control UI's `submit()` does the same. */
  async function finish() {
    await recorder.submit();
  }

  /** Back to idle: keeps the error (so the user can retry) but drops the take. */
  function retry() {
    recorder.cancel();
  }
</script>

<div
  data-control-ui="audio-recorder"
  data-control-family="audio-recorder"
  data-slot="root"
  data-state={recorder.state}
  class="flex min-w-0 items-center gap-2"
>
  <button
    type="button"
    data-control-ui="audio-recorder"
    data-slot="trigger"
    data-recorder-state={recorder.state}
    data-visible={recorder.canStart ? "true" : undefined}
    class="interactive grid size-11 shrink-0 cursor-pointer place-items-center rounded-full text-ink-muted hover:text-ink
      data-[visible=true]:text-ink disabled:cursor-not-allowed disabled:opacity-40"
    aria-label={recorder.canStart ? label : status || label}
    title={label}
    disabled={disabled || sending || live}
    onclick={() => void recorder.start()}
  >
    <Mic size={17} strokeWidth={1.75} aria-hidden="true" />
  </button>

  <!-- Everything past the trigger only exists while there is something to say. -->
  <div class="flex min-w-0 flex-1 items-center gap-2" data-visible={live || recording || errored ? "true" : undefined}>
    <span
      data-control-ui="audio-recorder"
      data-slot="status"
      data-tone={errored ? "error" : undefined}
      data-visible={status ? "true" : undefined}
      class="min-w-0 truncate text-[12px] text-ink-muted data-[tone=error]:text-err"
    >
      {status}
    </span>

    <AudioVisualizer
      levels={recorder.levels}
      active={live}
      points={28}
      class="ml-auto h-7 w-28 shrink-0"
      aria-label={recorder.state === "recording" ? "Nivel de la grabación" : undefined}
    />

    <span
      data-control-ui="audio-recorder"
      data-slot="duration"
      data-visible={recorder.durationMs > 0 ? "true" : undefined}
      class="tnum w-10 shrink-0 text-right text-[12px] text-ink-muted"
    >
      {formatAudioRecorderDuration(recorder.durationMs)}
    </span>

    {#if live}
      <button
        type="button"
        data-control-ui="audio-recorder"
        data-slot="submit"
        data-visible="true"
        class="interactive grid size-11 shrink-0 cursor-pointer place-items-center rounded-full bg-brand text-brand-ink
          disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Enviar la nota de voz"
        title="Enviar la nota de voz"
        disabled={sending}
        onclick={() => void finish()}
      >
        <Check size={17} strokeWidth={2} aria-hidden="true" />
      </button>
    {/if}

    {#if recording || errored}
      <button
        type="button"
        data-control-ui="audio-recorder"
        data-slot="cancel"
        data-visible="true"
        class="interactive grid size-11 shrink-0 cursor-pointer place-items-center rounded-full text-ink-muted
          hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={errored ? "Descartar y volver a grabar" : "Descartar la nota de voz"}
        title="Descartar"
        disabled={sending}
        onclick={retry}
      >
        {#if errored}
          <RotateCcw size={17} strokeWidth={1.75} aria-hidden="true" />
        {:else}
          <X size={17} strokeWidth={2} aria-hidden="true" />
        {/if}
      </button>
    {/if}
  </div>

  <!-- The state machine is also read out, not only coloured. -->
  <span class="sr-only" role="status" aria-live="polite">{status}</span>
</div>
