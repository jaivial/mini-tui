<!--
  Round 7's back-to-back A/B on the system prompt, median seconds per task. Arm A is what shipped
  before the clause, arm C is the clause that shipped with it. Lower is faster, so the shorter bar
  wins, and the paired reps it won are printed beside the pair: that is the honest reading of this
  lever, big wins on the derivation tasks and a couple of seconds lost on the trivial ones.
-->
<script lang="ts">
  import { scale } from "$lib/chart";
  import { AB } from "$lib/benchmark-data";

  const W = 760;
  const PAD = { top: 18, right: 8, bottom: 48, left: 40 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = 220;
  const H = plotH + PAD.top + PAD.bottom;
  const top = Math.ceil(Math.max(...AB.flatMap((r) => [r.a, r.c])) / 10) * 10;
  const y = (v: number) => scale(v, 0, top, plotH, 0);
  const ticks = Array.from({ length: top / 10 + 1 }, (_, i) => i * 10);
  const slot = plotW / AB.length;
  const barW = Math.min(18, slot * 0.34);
  const gap = 4;
  const fmt = (v: number) => `${v.toFixed(1)}s`;
</script>

<figure>
  <svg viewBox="0 0 {W} {H}" class="h-auto w-full" role="img"
    aria-label="Median seconds per task in the round 7 system-prompt A/B: without the clause against with it, t10 53.8 against 21.2 seconds, t7 16.6 against 10.1, t5 9.7 against 11.4.">
    {#each ticks as t (t)}
      <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--border)" stroke-width={t === 0 ? 1.5 : 1} />
      <text x={PAD.left - 8} y={y(t) + 4} text-anchor="end" class="fill-muted-foreground font-mono text-[11px]">{t}s</text>
    {/each}

    {#each AB as r, i (r.id)}
      {@const x0 = PAD.left + i * slot + (slot - (barW * 2 + gap)) / 2}
      {@const win = r.c < r.a}
      <!-- Arm A (shipped before) muted, arm C (the clause) primary when it wins. -->
      <rect x={x0} y={y(r.a)} width={barW} height={plotH - y(r.a)} rx="3" fill="var(--muted-foreground)" opacity="0.42" />
      <rect x={x0 + barW + gap} y={y(r.c)} width={barW} height={plotH - y(r.c)} rx="3"
        fill={win ? "var(--primary)" : "color-mix(in oklab, var(--primary) 42%, transparent)"} />
      <g role="img" aria-label="{r.name}: without the clause {fmt(r.a)} seconds, with it {fmt(r.c)} seconds, ratio {r.ratio}x, won {r.paired} paired reps.">
        <rect x={PAD.left + i * slot} y="0" width={slot} height={plotH} fill="transparent" />
      </g>
      <text x={PAD.left + i * slot + slot / 2} y={H - 24} text-anchor="middle" class="fill-foreground font-mono text-[11px] font-medium">{r.id}</text>
      <text x={PAD.left + i * slot + slot / 2} y={H - 10} text-anchor="middle" class="fill-muted-foreground font-mono text-[10px]">{r.paired}</text>
    {/each}
  </svg>
  <figcaption class="mt-3 text-xs text-muted-foreground">
    <span class="inline-flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-[3px] bg-muted-foreground opacity-45" aria-hidden="true"></span>arm A, prompt as shipped before</span>
      <span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-[3px] bg-primary" aria-hidden="true"></span>arm C, with the clause</span>
      <span>The pairs under each group are the paired reps C won.</span>
    </span>
  </figcaption>
</figure>