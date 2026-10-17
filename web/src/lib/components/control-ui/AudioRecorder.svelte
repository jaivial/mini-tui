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

  E21: what to paint comes from `recorderBarView()` (`../../recorderBar.ts`),
  not from booleans about the live microphone. The component had no notion of
  "a take exists": it gated the send button on `live`, so a take that had
  STOPPED — at the 5-minute cap, or after a failed upload — offered no way to
  send it at all. Measured against the deployed build; see the module's header.
  Focus also survives here: the trigger is no longer disabled while recording
  (it becomes the stop control, which is what a mic button does), and Escape
  discards the take instead of leaving the microphone open.
-->
<script lang="ts">
  import { Mic, X, Check, RotateCcw } from "@lucide/svelte";
  import AudioVisualizer from "./AudioVisualizer.svelte";
  import { useAudioRecorder, type AudioRecording } from "../../control-ui/recorder.svelte";
  import { formatAudioRecorderDuration } from "../../control-ui/format-audio-recorder-duration";
  import { recorderBarView, type RecorderState } from "../../recorderBar";

  let {
    disabled = false,
    maxDurationMs = 5 * 60 * 1000,
    label = "Grabar nota de voz",
    onRecordingComplete,
    onCancel,
    /** Called when the user discards a take with Escape, so the host can react. */
    onDiscard,
    /** Every state change, so the host can know whether a take is in hand. */
    onstatechange,
    /** Focus this element when the panel opens; the mic trigger by default. */
    autofocus = true,
  }: {
    disabled?: boolean;
    maxDurationMs?: number;
    label?: string;
    onRecordingComplete?: (recording: AudioRecording) => void | Promise<void>;
    onCancel?: () => void;
    onDiscard?: (state: RecorderState) => void;
    onstatechange?: (state: RecorderState) => void;
    autofocus?: boolean;
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

  // Mirrors in $state, not getters off the machine: Svelte cannot see a getter
  // change, so a `$derived` over them freezes at its first value (the same trap
  // E20 hit with the rename field). The template reads these and nothing else.
  let recorderState = $state<RecorderState>("idle");
  let error = $state<Error | null>(null);
  let durationMs = $state(0);
  let levels = $state<number[]>([]);

  $effect(() => {
    recorderState = recorder.state as RecorderState;
    error = recorder.error;
    durationMs = recorder.durationMs;
    levels = [...recorder.levels];
    onstatechange?.(recorderState);
  });

  const view = $derived(recorderBarView({ state: recorderState, error }));

  let triggerEl = $state<HTMLButtonElement | null>(null);
  let submitEl = $state<HTMLButtonElement | null>(null);

  /**
   * Focus follows the control that just took over the user's job.
   *
   * E21 measured: pressing the trigger started the recording, the trigger disabled
   * itself in the same tick, and `document.activeElement` became `body` — the next Tab
   * restarted at the top of the document and "Enviar" was unreachable without walking the
   * whole app. The trigger keeps Control UI's own rule (disabled while the mic is busy);
   * what was missing was the handover to the button that replaces it.
   *
   * This bar is not a dialog and must not trap Tab: focus is taken only when a control
   * appears, and only if it is not already inside the row.
   */
  $effect(() => {
    const opened = recorderState === "idle" || recorderState === "requesting";
    if (autofocus && opened) triggerEl?.focus();
    else if (view.showSubmit) submitEl?.focus();
  });

  /** Stop early and hand the blob over; Control UI's `submit()` does the same. */
  async function finish() {
    await recorder.submit();
  }

  /** Back to idle: keeps the error (so the user can retry) but drops the take. */
  function retry() {
    recorder.cancel();
  }

  /** Escape: throw the take away and say so, rather than leaving the mic open. */
  function onKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !view.canDiscard) return;
    event.preventDefault();
    event.stopPropagation();
    recorder.cancel();
    onDiscard?.(recorderState);
    triggerEl?.focus();
  }
</script>

<div
  data-control-ui="audio-recorder"
  data-control-family="audio-recorder"
  data-slot="root"
  data-state={recorderState}
  class="flex min-w-0 items-center gap-2"
  onkeydown={onKeydown}
>
  {#if view.showTrigger}
    <button
      bind:this={triggerEl}
      type="button"
      data-control-ui="audio-recorder"
      data-slot="trigger"
      data-recorder-state={recorderState}
      data-visible="true"
      class="interactive grid size-11 shrink-0 cursor-pointer place-items-center rounded-full text-ink-muted hover:text-ink
        disabled:cursor-not-allowed disabled:opacity-40"
      aria-label={view.triggerLabel}
      title={view.triggerLabel}
      aria-keyshortcuts="Escape"
      disabled={disabled || view.triggerDisabled}
      onclick={() => void recorder.start()}
    >
      <Mic size={17} strokeWidth={1.75} aria-hidden="true" />
    </button>
  {/if}

  <!-- Everything past the trigger only exists while there is something to say. -->
  <div class="flex min-w-0 flex-1 items-center gap-2" data-visible={view.status || view.canDiscard ? "true" : undefined}>
    <span
      data-control-ui="audio-recorder"
      data-slot="status"
      data-tone={view.statusIsError ? "error" : undefined}
      data-visible={view.status ? "true" : undefined}
      class="min-w-0 truncate text-[12px] text-ink-muted data-[tone=error]:text-err"
    >
      {view.status}
    </span>

    <AudioVisualizer
      {levels}
      active={view.meterActive}
      points={28}
      class="ml-auto h-7 w-28 shrink-0"
      aria-label={recorderState === "recording" ? "Nivel de la grabación" : undefined}
    />

    {#if view.showDuration}
      <span
        data-control-ui="audio-recorder"
        data-slot="duration"
        data-visible={durationMs > 0 ? "true" : undefined}
        class="tnum w-10 shrink-0 text-right text-[12px] text-ink-muted"
      >
        {formatAudioRecorderDuration(durationMs)}
      </span>
    {/if}

    {#if view.showSubmit}
      <button
        bind:this={submitEl}
        type="button"
        data-control-ui="audio-recorder"
        data-slot="submit"
        data-visible="true"
        class="interactive grid size-11 shrink-0 cursor-pointer place-items-center rounded-full bg-brand text-brand-ink
          disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Enviar la nota de voz"
        title="Enviar la nota de voz"
        disabled={view.submitDisabled}
        onclick={() => void finish()}
      >
        <Check size={17} strokeWidth={2} aria-hidden="true" />
      </button>
    {/if}

    {#if view.showCancel}
      <button
        type="button"
        data-control-ui="audio-recorder"
        data-slot="cancel"
        data-visible="true"
        class="interactive grid size-11 shrink-0 cursor-pointer place-items-center rounded-full text-ink-muted
          hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={view.cancelLabel}
        title="Descartar"
        aria-keyshortcuts="Escape"
        disabled={view.submitDisabled}
        onclick={retry}
      >
        {#if view.cancelIsRetry}
          <RotateCcw size={17} strokeWidth={1.75} aria-hidden="true" />
        {:else}
          <X size={17} strokeWidth={2} aria-hidden="true" />
        {/if}
      </button>
    {/if}
  </div>

  <!-- The state machine is also read out, not only coloured. -->
  <span class="sr-only" role="status" aria-live="polite">{view.status}</span>
</div>
