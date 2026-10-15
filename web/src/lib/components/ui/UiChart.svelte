<script lang="ts">
  /** Generative chart (bar | line) as plain SVG: validated numbers only. */
  import { validateChart } from "../../ui/validate";
  import { chartPlot, CHART_W, CHART_H, CHART_PAD } from "../../ui/chartGeometry";

  let { props }: { props: Record<string, unknown> } = $props();

  const chart = $derived(validateChart(props));
  // The reason is pulled out as its own `$derived` because `chart` is a `$derived` too: the template's
  // `{:else}` branch cannot narrow it to the `Invalid` variant, so reading `chart.reason` there is a
  // type error (`web:check` / CI red) even though only an invalid chart ever reaches that branch.
  const chartReason = $derived(chart.ok ? "" : chart.reason);
  // One band per value, shared by the plot and the label row below it. The geometry lives in
  // `ui/chartGeometry` so it can be tested, and it keeps every mark inside the viewBox: positions
  // used to be spread edge to edge (`i * (W-2*PAD)/(n-1)`, the right scale for a line) while bars
  // were sized on an `n` divisor, so the first bar hung off the left edge and the last off the
  // right one, half of each clipped away.
  const plot = $derived(chart.ok ? chartPlot(chart.props.values) : null);
  const path = $derived(plot ? plot.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") : "");
  const hasNegative = $derived(!!chart.ok && Math.min(...chart.props.values, 0) < 0);
</script>

{#if chart.ok && plot}
  <div class="ui-surface">
    {#if chart.props.title}
      <div class="flex items-baseline justify-between gap-3">
        <p class="ui-chart-title">{chart.props.title}</p>
        {#if chart.props.unit}<span class="text-[11px] text-ink-faint">{chart.props.unit}</span>{/if}
      </div>
    {/if}
    <!-- The plot and the label row share one column, so a label always sits under its own mark. -->
    <div class="ui-chart-body">
      <svg viewBox="0 0 {CHART_W} {CHART_H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label={chart.props.title ?? "Gráfico"}>
        {#if hasNegative}
          <!-- The zero line, so a bar that crosses it reads as negative rather than merely short. -->
          <line x1={CHART_PAD} y1={plot.zeroY} x2={CHART_W - CHART_PAD} y2={plot.zeroY} stroke="var(--color-line-strong)" stroke-width="1" />
        {/if}
        {#if chart.props.kind === "bar"}
          {#each plot.points as p, i (i)}
            <rect
              x={p.x - plot.barWidth / 2}
              y={Math.min(p.y, plot.zeroY)}
              width={plot.barWidth}
              height={Math.max(1, Math.abs(plot.zeroY - p.y))}
              rx="2"
              class="fill-brand/80"
            />
          {/each}
        {:else}
          <path d={path} fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" class="stroke-brand" />
          {#each plot.points as p, i (i)}
            <circle cx={p.x} cy={p.y} r="2.5" class="fill-brand" />
          {/each}
        {/if}
      </svg>
      <!-- One equal cell per band: flex-1 centres each label on its own mark. `space-between`
           spread them edge to edge across a row wider than the plot, so the last label sat under
           empty space. -->
      <div class="ui-chart-labels" aria-hidden="true">
        {#each chart.props.labels as label, i (i)}
          <span title={label}>{label}</span>
        {/each}
      </div>
    </div>
  </div>
{:else}
  <div class="flex items-start gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-[12px] text-ink-faint" role="note">
    Gráfico no renderizado: {chartReason}
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
  /* One column for the plot and its labels, so the two can never disagree on width. */
  .ui-chart-body {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    width: 100%;
    max-width: 24rem;
  }
  .ui-chart-body :global(svg) {
    display: block;
    width: 100%;
    height: auto;
  }
  .ui-chart-labels {
    display: flex;
    width: 100%;
    gap: 0;
    font-size: 10.5px;
    color: var(--color-ink-faint);
  }
  .ui-chart-labels span {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
