<!--
  The aggregate ratio (mini / pi) round by round. Below 1.00x is faster for mini. Three things are
  marked on purpose: the 1.00x tie line, the round-6 median with the three fresh reps that produced
  it, and round 5's 0.69x drawn as a single hollow point on a dashed segment, because that is the
  run round 6 showed to be variance. Honest charts show the outlier; they just do not dress it up.
-->
<script lang="ts">
  import { scale } from "$lib/chart";
  import { REPS, ROUNDS, TIE } from "$lib/benchmark-data";

  const W = 760;
  const H = 300;
  const PAD = { top: 34, right: 24, bottom: 54, left: 44 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const min = 0.4;
  const max = 4.6;
  const y = (v: number) => scale(v, min, max, plotH, 0);
  const x = (i: number) => PAD.left + (plotW / (ROUNDS.length - 1)) * i;
  const ticks = [0.5, 1, 2, 3, 4];
  const line = (i: number) => `${x(i)},${y(ROUNDS[i].ratio)}`;
  // Solid through the rounds that stand; dashed into R5 and out of it, the two segments that R6 undid.
  const fmt = (v: number) => `${v.toFixed(2)}x`;
</script>

<figure>
  <svg viewBox="0 0 {W} {H}" class="h-auto w-full" role="img"
    aria-label="Aggregate speed ratio of mini-tui against the pi harness per round: R1 3.65x, R2 1.28x, R3 0.95x, R4 1.07x, R5 0.69x, R6 0.98x, where below 1.00x is faster for mini.">
    {#each ticks as t (t)}
      <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={t === TIE ? "var(--muted-foreground)" : "var(--border)"} stroke-width={t === TIE ? 1.5 : 1} stroke-dasharray={t === TIE ? "4 4" : undefined} />
      <text x={PAD.left - 10} y={y(t) + 4} text-anchor="end" class="fill-muted-foreground font-mono text-[11px]">{t.toFixed(t === 1 ? 2 : 1)}x</text>
    {/each}

    <!-- Segments: 3->4 and 4->5 dashed (the R5 run the reps disproved), the rest solid. -->
    <polyline points={[line(0), line(1), line(2), line(3)].join(" ")} fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    <polyline points="{line(3)} {line(4)} {line(5)}" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="6 5" opacity="0.75" />

    <!-- R5 hollow: one run, not a trend. The label sits above-left so it clears the axis. -->
    <circle cx={x(4)} cy={y(ROUNDS[4].ratio)} r="5" fill="var(--card)" stroke="var(--primary)" stroke-width="2.5" stroke-dasharray="3 2" />
    <text x={x(4)} y={y(ROUNDS[4].ratio) - 26} text-anchor="middle" class="fill-primary font-mono text-[11px] font-semibold">0.69x*</text>
    <text x={x(4)} y={y(ROUNDS[4].ratio) - 15} text-anchor="middle" class="tuck fill-muted-foreground text-[9px]">one run</text>

    {#each ROUNDS as r, i (r.round)}
      {#if !r.variance}
        <circle cx={x(i)} cy={y(r.ratio)} r={r.current ? 5.5 : 4} fill="var(--primary)" stroke="var(--card)" stroke-width="2" />
        <!-- R1's label goes below its point: above would sit on the 4.0x gridline. -->
        <text x={x(i)} y={i === 0 ? y(r.ratio) + 17 : y(r.ratio) - 14} text-anchor="middle" class={r.current ? "fill-primary font-mono text-[11px] font-semibold" : "fill-foreground font-mono text-[11px]"}>{fmt(r.ratio)}</text>
      {/if}
      <g role="img" aria-label="{r.round}: {fmt(r.ratio)}, {r.won} tasks won. {r.note}">
        <rect x={Math.min(x(i) - 26, W - 6)} y={PAD.top} width="52" height={plotH} fill="transparent" />
      </g>
      <text x={x(i)} y={H - 26} text-anchor="middle" class={r.current ? "fill-primary font-mono text-[11px] font-semibold" : "fill-muted-foreground font-mono text-[11px]"}>{r.round}</text>
    {/each}

    <!-- The three round-6 reps, drawn as the range behind the median, in the open gap left of R6. On a
         phone the SVG scales too far for three labels to stay legible, so the numbers move to the
         caption and the bracket keeps the range visible. -->
    <g class="fill-muted-foreground font-mono text-[10px]">
      <text class="tuck" x={x(5) - 18} y={y(REPS[0].ratio) + 4} text-anchor="end">1.13x</text>
      <text class="tuck" x={x(5) - 18} y={y(REPS[2].ratio) + 4} text-anchor="end">0.93x</text>
    </g>
    <line x1={x(5) - 15} x2={x(5) - 15} y1={y(REPS[0].ratio)} y2={y(REPS[2].ratio)} stroke="var(--muted-foreground)" stroke-width="1.5" opacity="0.5" />

    <text x={PAD.left + plotW / 2} y={H - 8} text-anchor="middle" class="fill-muted-foreground text-[10px]">Below 1.00x, mini is faster. Dashed = the single round-5 run that three fresh reps did not reproduce.</text>
  </svg>
  <figcaption class="mt-3 text-xs text-muted-foreground">
    *R5's 0.69x is one run. Round 6 repeated the whole corpus three times (1.13x, 0.98x, 0.93x, the grey bracket at R6) and the
    median of those is <strong class="text-foreground">0.98x</strong>, a tie. We plotted the lucky run rather than hide it, and marked it for what it was.
  </figcaption>
</figure>

<style>
  /* On a phone the SVG scales far enough that three small labels stop being legible, so the minor
     annotations step aside. Their numbers stay in the caption and in each point's aria-label. */
  @media (max-width: 420px) {
    .tuck { display: none; }
  }
</style>