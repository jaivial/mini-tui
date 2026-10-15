<!--
  Control UI — `AudioVisualizer` (bars variant)

  Ported from control-ui.dev's registry source
  (`src/registry/sources/control-ui/audio-visualizer.tsx`, registry item
  `audio-visualizer`, fetched 2026-10-15). MIT, © Damien Schneider.
  https://control-ui.dev/kits/audio-visualizer

  What travels unchanged from Control UI's source:
    - the same `data-control-family="audio-visualizer"` / `data-slot` anatomy
      its own recipe CSS and effects target,
    - `audioVisualizerHistory` for the bar window (verbatim),
    - the perceptual curve: `sqrt(level)`, a 4% floor, opacity 0.48→1,
    - the scroll animation (WAAPI, translated track) including its 16ms/250ms
      guard rails, `document.hidden` check and `prefers-reduced-motion` kill,
    - `role="img"` + `aria-hidden` decided by whether the caller labelled it.

  What changes, and only because the host is Svelte 5 rather than React:
    - props are runes, not `ComponentProps`,
    - `className` → `class`,
    - `useRef` → an action (Svelte's `bind:this` cannot be conditional,
      and Control UI only ever reads the first bar once),
    - the per-bar `style` object is serialized into a style string.
-->
<script lang="ts">
  import { audioVisualizerHistory } from "../../control-ui/audio-visualizer-levels";
  import { knobsToStyle } from "../../control-ui/knob-style";

  let {
    levels,
    active = true,
    points,
    class: klass = "",
    style,
    ...rest
  }: {
    levels: ArrayLike<number>;
    active?: boolean;
    points?: number;
    class?: string;
    /** Control UI's `--cui-audio-visualizer-*` knobs, as an object. */
    style?: Record<string, string | number | undefined>;
    /** Anything else lands on the root, as it does in Control UI's spread. */
    [key: string]: unknown;
  } = $props();

  const MIN_VISIBLE_LEVEL = 0.04;

  type HistorySample = { levels: number[]; time: number; active: boolean };

  /** A new frame only when the window actually slid: one bar in, one out. */
  function historyAdvanced(previous: HistorySample | null, next: HistorySample) {
    if (!previous?.active || !next.active || previous.levels.length !== next.levels.length || next.levels.length < 2) return false;
    const moved = previous.levels.slice(1).every((level, index) => level === next.levels[index]);
    const changed = previous.levels.some((level, index) => level !== next.levels[index]);
    return moved && changed;
  }

  const visible = $derived(audioVisualizerHistory(levels, points, active));
  const labelled = $derived(Boolean(rest["aria-label"] || rest["aria-labelledby"]));

  let trackEl = $state<HTMLSpanElement | null>(null);
  let firstBarEl = $state<HTMLSpanElement | null>(null);

  /** Control UI reads the first bar only to measure one bar's width. `firstBarEl`
   * is written by the action and read by the effect below, so it stays reactive
   * — but the effect only ever READS it, never writes it, which is what keeps
   * the effect from depending on its own output. */
function firstBar(node: HTMLSpanElement, isFirst: boolean) {
    if (isFirst) firstBarEl = node;
  }

  // The track is translated by exactly one bar pitch, so incoming levels slide
  // in from the edge instead of every bar re-growing on its own. Same as
  // Control UI: driven by the WAAPI, cancelled when the frame is superseded.
  //
  // `previousSample` must NOT be reactive state read inside this effect: the
  // effect writes it on every run, so reading it would make it depend on the
  // value it just wrote and re-run forever (Svelte tears the component down
  // with `effect_update_depth_exceeded` — 58 remounts before it bailed). A
  // plain closure variable carries the previous frame without being a
  // dependency, which is exactly what React's `useRef` does upstream.
  let previousSample: HistorySample | null = null;

  $effect(() => {
    const levelsNow = visible.map(({ level }) => level);
    const next: HistorySample = { levels: levelsNow, time: performance.now(), active };
    const previous = previousSample;
    previousSample = next;

    const track = trackEl;
    const firstBar = firstBarEl;
    if (!track || !firstBar || !historyAdvanced(previous, next) || document.hidden) return;
    const duration = next.time - (previous?.time ?? next.time);
    if (duration < 16 || duration > 250 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const direction = getComputedStyle(track).direction === "rtl" ? -1 : 1;
    const pitch = (track.clientWidth - firstBar.clientWidth) / (levelsNow.length - 1);
    const animation = track.animate([{ transform: `translateX(${pitch * direction}px)` }, { transform: "translateX(0)" }], {
      duration,
      easing: "linear",
    });
    return () => animation.cancel();
  });

  /** `sqrt` + a floor so silence still draws a hairline, then a clip-path that
   *  grows the bar from its centre. Control UI's own paint. */
  function barStyle(level: number): string | undefined {
    const perceptualLevel = Math.sqrt(level);
    const visibleLevel = MIN_VISIBLE_LEVEL + perceptualLevel * (1 - MIN_VISIBLE_LEVEL);
    return knobsToStyle({
      "--_audio-visualizer-level-opacity": `${0.48 + perceptualLevel * 0.52}`,
      "clip-path": `inset(${(1 - visibleLevel) * 50}% 0 round var(--cui-audio-visualizer-bar-radius))`,
    });
  }
</script>

<div
  data-control-ui="audio-visualizer"
  data-control-family="audio-visualizer"
  data-slot="root"
  data-variant="bars"
  data-active={active ? "true" : undefined}
  role={labelled ? "img" : undefined}
  aria-hidden={labelled ? undefined : "true"}
  class="shrink-0 overflow-hidden mask-x-from-90% {klass}"
  style={knobsToStyle(style)}
  {...rest}
>
  <span
    bind:this={trackEl}
    data-control-ui="audio-visualizer"
    data-control-family="audio-visualizer"
    data-slot="track"
    data-active={active ? "true" : undefined}
    class="flex size-full items-stretch justify-between"
  >
    {#each visible as { key, level } (key)}
      <span
        use:firstBar={key === "bar-0"}
        data-control-ui="audio-visualizer"
        data-control-family="audio-visualizer"
        data-slot="bar-track"
        class="flex items-center"
      >
        <span
          data-control-ui="audio-visualizer"
          data-control-family="audio-visualizer"
          data-slot="bar"
          class="block h-full w-full"
          style={barStyle(level)}
        ></span>
      </span>
    {/each}
  </span>
</div>
