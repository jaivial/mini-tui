<!--
  Grouped bars, mini against pi, one group per task. Same corpus, same model, sequential, median of
  the four complete runs. Short bars mean less wall time, so a short mini bar is a won task, and the
  winner of each group is named in the caption under it.

  Hand-rolled SVG on purpose: shadcn's charts delegate to layerchart, which measures the container
  in the browser, and this page is prerendered to static HTML. The visual language is the site's own
  shadcn tokens (primary for mini, muted for pi, hairline grid, small mono labels).
-->
<script lang="ts">
  import { scale } from "$lib/chart";
  import { TASKS } from "$lib/benchmark-data";

  const W = 760;
  const PAD = { top: 18, right: 8, bottom: 46, left: 40 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = 250;
  const H = plotH + PAD.top + PAD.bottom;
  const top = Math.ceil(Math.max(...TASKS.flatMap((t) => [t.mini, t.pi])) / 20) * 20;
  const y = (v: number) => scale(v, 0, top, plotH, 0);
  const ticks = Array.from({ length: top / 20 + 1 }, (_, i) => i * 20);
  const slot = plotW / TASKS.length;
  const barW = Math.min(18, slot * 0.34);
  const gap = 4;

  const fmt = (v: number) => `${v.toFixed(1)}s`;
</script>

<figure>
  <svg viewBox="0 0 {W} {H}" class="h-auto w-full" role="img"
    aria-label="Median seconds per task over four complete runs, mini-tui against the pi harness. mini is faster on {TASKS.filter((t) => t.ratio < 1).length} of {TASKS.length} tasks.">
    <!-- Gridlines and the seconds axis -->
    {#each ticks as t (t)}
      <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--border)" stroke-width={t === 0 ? 1.5 : 1} />
      <text x={PAD.left - 8} y={y(t) + 4} text-anchor="end" class="fill-muted-foreground font-mono text-[11px]">{t}s</text>
    {/each}

    {#each TASKS as t, i (t.id)}
      {@const x0 = PAD.left + i * slot + (slot - (barW * 2 + gap)) / 2}
      {@const win = t.ratio < 1}
      <!-- The winner keeps the primary fill; the loser goes muted, so won/lost reads at a glance. -->
      <rect x={x0} y={y(t.mini)} width={barW} height={plotH - y(t.mini)} rx="3"
        fill={win ? "var(--primary)" : "color-mix(in oklab, var(--primary) 42%, transparent)"} />
      <rect x={x0 + barW + gap} y={y(t.pi)} width={barW} height={plotH - y(t.pi)} rx="3" fill="var(--muted-foreground)" opacity="0.42" />
      <g role="img" aria-label="{t.name}: mini {fmt(t.mini)} seconds, range {t.miniRange}; pi {fmt(t.pi)} seconds, range {t.piRange}; ratio {t.ratio.toFixed(2)}x, {win ? "mini faster" : "pi faster"}.">
        <rect x={PAD.left + i * slot} y="0" width={slot} height={plotH} fill="transparent" />
      </g>
      <text x={PAD.left + i * slot + slot / 2} y={H - 22} text-anchor="middle" class="fill-foreground font-mono text-[11px] font-medium">{t.id}</text>
      <text x={PAD.left + i * slot + slot / 2} y={H - 8} text-anchor="middle" class="fill-muted-foreground font-mono text-[10px]">{fmt(t.mini)}</text>
    {/each}
  </svg>
  <figcaption class="mt-3 text-xs text-muted-foreground">
    <span class="inline-flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-[3px] bg-primary" aria-hidden="true"></span>mini-tui, median of 4 runs</span>
      <span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-[3px] bg-muted-foreground opacity-45" aria-hidden="true"></span>pi harness</span>
      <span>{TASKS.filter((t) => t.ratio < 1).length} of {TASKS.length} tasks won on the median; the numbers under each pair are mini's median.</span>
    </span>
  </figcaption>
</figure>