<script lang="ts">
  import { scale } from "$lib/chart";
  import { REPS, ROUNDS, TIE } from "$lib/benchmark-data";

  const W = 760;
  const H = 300;
  const PAD = { top: 34, right: 24, bottom: 54, left: 44 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const min = 0.5;
  const max = 5;
  const y = (v: number) => scale(v, min, max, plotH, 0);
  const x = (i: number) => PAD.left + (plotW / (ROUNDS.length - 1)) * i;
  const ticks = [1, 2, 3, 4, 5];
  const line = (i: number) => `${x(i)},${y(ROUNDS[i].ratio)}`;
  const fmt = (v: number) => `${v.toFixed(2)}x`;
</script>

<figure>
  <svg viewBox="0 0 {W} {H}" class="h-auto w-full" role="img"
    aria-label="Optimization path: baseline 1.52x, fast close 1.89x, eager 2.85x, strict final 2.43x. Higher is faster for mini-tui.">
    {#each ticks as t (t)}
      <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={t === TIE ? "var(--muted-foreground)" : "var(--border)"} stroke-width={t === TIE ? 1.5 : 1} stroke-dasharray={t === TIE ? "4 4" : undefined} />
      <text x={PAD.left - 10} y={y(t) + 4} text-anchor="end" class="fill-muted-foreground font-mono text-[11px]">{t.toFixed(1)}x</text>
    {/each}

    <polyline points={ROUNDS.map((_, i) => line(i)).join(" ")} fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />

    {#each ROUNDS as r, i (r.round)}
      <circle cx={x(i)} cy={y(r.ratio)} r={r.current ? 5.5 : 4} fill="var(--primary)" stroke="var(--card)" stroke-width="2" />
      <text x={x(i)} y={y(r.ratio) - 15} text-anchor="middle" class={r.current ? "fill-primary font-mono text-[11px] font-semibold" : "fill-foreground font-mono text-[11px]"}>{fmt(r.ratio)}</text>
      <g role="img" aria-label="{r.round}: {fmt(r.ratio)}, {r.won} tasks passed on each arm. {r.note}">
        <rect x={Math.min(x(i) - 30, W - 6)} y={PAD.top} width="60" height={plotH} fill="transparent" />
      </g>
      <text x={x(i)} y={H - 26} text-anchor="middle" class={r.current ? "fill-primary font-mono text-[11px] font-semibold" : "fill-muted-foreground font-mono text-[11px]"}>{r.round}</text>
    {/each}

    <text x={PAD.left + plotW / 2} y={H - 8} text-anchor="middle" class="fill-muted-foreground text-[10px]">Higher is faster for mini. Dashed line = parity with pi.</text>
  </svg>
  <figcaption class="mt-3 text-xs text-muted-foreground">
    The eager repetitions are <strong class="text-foreground">{REPS[0].ratio.toFixed(2)}x</strong>, <strong class="text-foreground">{REPS[1].ratio.toFixed(2)}x</strong> and <strong class="text-foreground">{REPS[2].ratio.toFixed(2)}x</strong>, each with 20/20 PASS across both arms. The strict final run uses a fresh, single repetition and is not pooled with them.
  </figcaption>
</figure>
