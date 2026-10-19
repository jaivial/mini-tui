<script lang="ts">
  import { duration } from "../format";
  import { clock } from "../stores/clock.svelte";
  /**
   * Pixel-grid loader with a shimmering label and an elapsed timer, after beautifului.dev's
   * "Loading State". The grid and the shimmer are decoration (`aria-hidden`); the label is the
   * one announcement, and the timer stays out of the live region so a screen reader is not read
   * a new number every second. Reduced motion freezes the grid to its dim state; the timer ticks.
   */
  let {
    label = "Working",
    since = 0,
    class: klass = "",
  }: { label?: string; since?: number; class?: string } = $props();

  // A chevron wavefront: delay grows with distance from the left edge, bent at the middle row,
  // and the cycle (650ms) is shorter than the sweep so two fronts are always in flight.
  const CELLS = Array.from({ length: 9 }, (_, i) => {
    const r = Math.floor(i / 3);
    const c = i % 3;
    return (c + Math.abs(r - 1)) * 90;
  });

  // The loader's elapsed counter is a claim about the clock (E53): it reads the shared one and is
  // woken exactly when its words can change. It used to run its own 1 s `setInterval` — and it had
  // its own copy of the elapsed words ("1m 05s" vs the app's "1m 5s").
  const elapsed = $derived.by(() => (since ? duration(Math.max(0, clock.now - since)) : ""));
  $effect(() => {
    if (since) return clock.watchAge("elapsed", since);
  });
</script>

<div class="flex w-fit items-center gap-2.5 {klass}">
  <span aria-hidden="true" class="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
    {#each CELLS as delay, i (i)}
      <span class="cell size-[4px] rounded-[1px] bg-ink" style="animation-delay: {delay}ms"></span>
    {/each}
  </span>
  <span role="status" class="shimmer-label text-[13px] font-medium">{label}</span>
  {#if elapsed}
    <span aria-hidden="true" class="tnum font-mono text-[12px] text-ink-faint">{elapsed}</span>
  {/if}
</div>

<style>
  .cell {
    opacity: 0.15;
    animation: pixel-on 650ms ease-in-out infinite;
  }
  .shimmer-label {
    background-image: linear-gradient(90deg, var(--color-ink-muted) 35%, var(--color-ink) 50%, var(--color-ink-muted) 65%);
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: shimmer-text 1.4s linear infinite;
  }
</style>
