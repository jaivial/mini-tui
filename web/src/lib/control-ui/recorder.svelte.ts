/**
 * Control UI — `useAudioRecorder`, Svelte 5 edition.
 *
 * This is the React-shell replacement for control-ui.dev's `useAudioRecorder`
 * (registry item `audio-recorder`, fetched 2026-10-15, MIT © Damien Schneider).
 * Control UI ships React only, so its hook cannot run here; the controller
 * underneath it is framework-free and is used verbatim — see
 * `./audio-recorder-controller.ts`. This file is the same hook contract in
 * runes: same options, same result shape, same `canStart`/`canCancel`/
 * `canSubmit` rules, and the same lifecycle (destroy on unmount, re-apply
 * options whenever they change).
 */
import {
  createAudioRecorderController,
  preferredAudioMimeType,
  type AudioRecorderState,
  type AudioRecording,
  type AudioRecorderSnapshot,
  type UseAudioRecorderOptions,
  type UseAudioRecorderResult,
} from "./audio-recorder-controller";

export type { AudioRecorderState, AudioRecording, AudioRecorderSnapshot, UseAudioRecorderOptions };
export { preferredAudioMimeType };

export type AudioRecorder = UseAudioRecorderResult & {
  /** Re-apply the options object. Cheap; call it from an `$effect`. */
  setOptions(next: UseAudioRecorderOptions): void;
  /** Stop everything and drop the listeners. Called on unmount. */
  destroy(): void;
};

/** Whether this state can still throw the recording away. */
export function recordingStateCanCancel(state: AudioRecorderState): boolean {
  return state === "requesting" || state === "recording" || state === "recorded" || state === "error";
}

/**
   * Record from the microphone, with Control UI's own state machine
   * (`idle → requesting → recording → recorded → submitting`, or `error`).
   *
   * ```svelte
   * const recorder = useAudioRecorder({ onRecordingComplete: (r) => upload(r.blob) });
   * ```
   *
   * Must be called during component init (it holds `$state`), and `destroy()`
   * runs on unmount so the microphone is never left open.
   *
   * `options` is kept as the LIVE object the caller passed, never a copy: the
   * controller's `setOptions` spreads what it is given, and spreading an object
   * whose properties are getters would read every reactive prop inside the
   * `$effect` below — the effect would then depend on the props it just
   * consumed and re-run forever. Passing the object through also means the
   * controller always sees the current handler without re-wiring on change.
   */
export function useAudioRecorder(options: UseAudioRecorderOptions = {}): AudioRecorder {
  const controller = createAudioRecorderController(options);
  let snapshot = $state<AudioRecorderSnapshot>(controller.getSnapshot());

  const unsubscribe = controller.subscribe(() => {
    snapshot = controller.getSnapshot();
  });

  $effect(() => {
    // Read the props so a change re-applies them, but never let the controller
    // copy the object: the copy would collapse the getters into plain values.
    const live: UseAudioRecorderOptions = options;
    void live.disabled;
    void live.maxDurationMs;
    void live.onRecordingComplete;
    void live.onCancel;
    controller.setOptions(live);
  });

  $effect(() => {
    return () => controller.destroy();
  });

  const isDisabled = $derived(Boolean(options.disabled));

  return {
    get state() {
      return snapshot.state;
    },
    get durationMs() {
      return snapshot.durationMs;
    },
    get levels() {
      return snapshot.levels;
    },
    get error() {
      return snapshot.error;
    },
    get recording() {
      return snapshot.recording;
    },
    get isDisabled() {
      return isDisabled;
    },
    get canStart() {
      return !isDisabled && (snapshot.state === "idle" || snapshot.state === "error");
    },
    get canCancel() {
      return recordingStateCanCancel(snapshot.state);
    },
    get canSubmit() {
      return snapshot.state === "recording" || snapshot.state === "recorded";
    },
    start: controller.start,
    stop: controller.stop,
    cancel: controller.cancel,
    submit: controller.submit,
    setOptions: controller.setOptions,
    destroy() {
      unsubscribe();
      controller.destroy();
    },
  };
}
