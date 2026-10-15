<script lang="ts">
  /** Generative chart (bar | line) as plain SVG: validated numbers only. */
  import { validateChart } from "../../ui/validate";

  let { props }: { props: Record<string, unknown> } = $props();

  const chart = $derived(validateChart(props));
  const W = 320;
  const H = 140;
  const PAD = 6;

  const points = $derived.by(() => {
    if (!chart.ok) return [];
    const { values } = chart.props;
    const max = Math.max(...values, 0);
    const min = Math.min(...values, 0);
    const span = max - min || 1;
    const step = values.length > 1 ? (W - PAD * 2) / (values.length - 1) : 0;
    return values.map((v, i) => ({
      x: PAD + (values.length > 1 ? i * step : (W - PAD * 2) / 2),
      y: PAD + (1 - (v - min) / span) * (H - PAD * 2),
      v,
    }));
  });
  const path = $derived(points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));
</script>

{#if chart.ok}
  <div class="ui-surface">
    {#if chart.props.title}
      <div class="flex items-baseline justify-between gap-3">
        <p class="ui-chart-title">{chart.props.title}</p>
        {#if chart.props.unit}<span class="text-[11px] text-ink-faint">{chart.props.unit}</span>{/if}
      </div>
    {/if}
    <svg viewBox="0 0 {W} {H}" class="w-full max-w-sm" role="img" aria-label={chart.props.title ?? "Gráfico"}>
      {#if chart.props.kind === "bar"}
        {#each points as p, i (i)}
          {@const base = PAD + (H - PAD * 2) * (Math.min(...chart.props.values, 0) < 0 ? (0 - Math.min(...chart.props.values, 0)) / (Math.max(...chart.props.values, 0) - Math.min(...chart.props.values, 0) || 1) : 1)}
          <rect
            x={p.x - Math.max(3, (W - PAD * 2) / points.length / 2 - 2)}
            y={Math.min(p.y, base)}
            width={Math.max(6, (W - PAD * 2) / points.length - 3)}
            height={Math.max(1, Math.abs(base - p.y))}
            rx="2"
            class="fill-brand/80"
          />
        {/each}
      {:else}
        <path d={path} fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" class="stroke-brand" />
        {#each points as p, i (i)}
          <circle cx={p.x} cy={p.y} r="2.5" class="fill-brand" />
        {/each}
      {/if}
    </svg>
    <div class="ui-chart-labels" aria-hidden="true">
      {#each chart.props.labels as label, i (i)}
        <span>{label}</span>
      {/each}
    </div>
  </div>
{:else}
  <div class="flex items-start gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-[12px] text-ink-faint" role="note">
    Gráfico no renderizado: {chart.reason}
  </div>
{/if}

<style>
  .ui-surface {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    max-width: 100%;
    padding: 0.75rem 0.875rem;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-lg, 12px);
    background: var(--color-canvas);
  }
  .ui-chart-title {
    font-weight: 600;
    font-size: 13px;
    color: var(--color-ink);
  }
  .ui-chart-labels {
    display: flex;
    justify-content: space-between;
    gap: 0.25rem;
    overflow: hidden;
    font-size: 10.5px;
    color: var(--color-ink-faint);
  }
  .ui-chart-labels span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
