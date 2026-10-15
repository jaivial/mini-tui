<script lang="ts">
  /**
   * v6-B: what the model calls have cost, per provider and per model.
   *
   * Read-only, like the rest of this tab: a window selector, the totals, and the
   * two tables. The one rule this component exists to enforce visually is that an
   * unpriced model reads as *desconocido* — never as $0.00 — because a zero would
   * say "free" about a call nobody has priced. When the price catalog is missing
   * the panel says so once, at the top, instead of leaving every cell blank.
   */
  import { Activity } from "@lucide/svelte";
  import {
    UsageClient,
    USAGE_WINDOWS,
    formatCost,
    formatLatency,
    formatTokens,
    formatWhen,
    rowTokens,
    type UsageRow,
    type UsageView,
  } from "../usageClient";

  let { open = false }: { open?: boolean } = $props();

  const client = new UsageClient();
  let view = $state<UsageView | null>(null);
  let window_ = $state<string>("24h");
  let error = $state("");
  let poller: ReturnType<typeof setInterval> | undefined;

  async function load() {
    try {
      view = await client.window(window_);
      error = "";
    } catch (e) {
      error = (e as Error).message;
    }
  }

  $effect(() => {
    if (!open) return;
    void load();
    poller = setInterval(() => { void load(); }, 15_000);
    return () => {
      if (poller) clearInterval(poller);
      poller = undefined;
    };
  });

  // A window change refetches immediately; the poll keeps the same window.
  $effect(() => {
    const selected = window_;
    if (!open) return;
    void client.window(selected).then((next) => { view = next; error = ""; }).catch((e) => { error = (e as Error).message; });
  });

  function rows(list: UsageRow[]) {
    return list.length ? list : [];
  }
</script>

<section class="mb-3 rounded-2xl border border-line/80 bg-surface/70 p-3" aria-label="Uso de modelos">
  <div class="flex items-center gap-2">
    <span class="grid size-6 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand" aria-hidden="true">
      <Activity size={13} strokeWidth={1.75} />
    </span>
    <h3 class="min-w-0 flex-1 text-[12.5px] font-semibold tracking-[-0.01em] text-ink">Uso de modelos</h3>
    <span class="text-[10px] font-semibold tracking-wider text-ink-faint uppercase">Solo lectura</span>
  </div>

  <div class="mt-2 flex flex-wrap gap-1" role="group" aria-label="Ventana temporal">
    {#each USAGE_WINDOWS as w (w.id)}
      <button
        type="button"
        class="rounded-md px-1.5 py-0.5 text-[10.5px] font-medium {window_ === w.id ? 'bg-brand-soft text-brand' : 'text-ink-muted hover:text-ink'}"
        aria-pressed={window_ === w.id}
        onclick={() => { window_ = w.id; void load(); }}
      >{w.label}</button>
    {/each}
  </div>

  {#if error}
    <p role="status" class="mt-2 text-[11.5px] leading-5 text-warn">{error}. Reintentando…</p>
  {:else if !view}
    <p role="status" class="mt-2 text-[11.5px] text-ink-muted">Leyendo uso…</p>
  {:else if !view.configured}
    <p class="mt-2 text-[11.5px] leading-5 text-ink-muted">
      Aún no hay llamadas registradas en este host. En cuanto corra un turno, aquí verás tokens, coste y latencia por proveedor.
    </p>
  {:else if !view.totals.calls}
    <p class="mt-2 text-[11.5px] leading-5 text-ink-muted">Sin llamadas en esta ventana.</p>
  {:else}
    {#if !view.pricesConfigured}
      <p class="mt-2 rounded-lg border border-line/70 bg-canvas/60 px-2 py-1.5 text-[10.5px] leading-4 text-ink-muted">
        Sin catálogo de precios: el coste se marca como <span class="text-ink">desconocido</span> en lugar de estimarlo.
      </p>
    {:else if !view.costComplete}
      <p class="mt-2 rounded-lg border border-line/70 bg-canvas/60 px-2 py-1.5 text-[10.5px] leading-4 text-ink-muted">
        Coste parcial: hay modelos sin precio en el catálogo, así que la suma solo cubre lo conocido.
      </p>
    {/if}

    <dl class="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-4">
      <div>
        <dt class="text-[9.5px] font-semibold tracking-wider text-ink-faint uppercase">Llamadas</dt>
        <dd class="tnum text-[13px] font-semibold text-ink">{view.totals.calls}</dd>
      </div>
      <div>
        <dt class="text-[9.5px] font-semibold tracking-wider text-ink-faint uppercase">Tokens</dt>
        <dd class="tnum text-[13px] font-semibold text-ink">{formatTokens(rowTokens(view.totals))}</dd>
      </div>
      <div>
        <dt class="text-[9.5px] font-semibold tracking-wider text-ink-faint uppercase">Coste</dt>
        <dd class="tnum text-[13px] font-semibold text-ink">{formatCost(view.totals.costUsd, view.totals.unknownCostCalls)}</dd>
      </div>
      <div>
        <dt class="text-[9.5px] font-semibold tracking-wider text-ink-faint uppercase">Latencia media</dt>
        <dd class="tnum text-[13px] font-semibold text-ink">{formatLatency(view.totals.avgLatencyMs)}</dd>
      </div>
    </dl>

    <div class="mt-3">
      <h4 class="text-[10px] font-semibold tracking-wider text-ink-faint uppercase">Por proveedor</h4>
      {#if !rows(view.byProvider).length}
        <p class="mt-1 text-[11px] text-ink-faint">Sin datos.</p>
      {:else}
        <ul class="mt-1 flex flex-col gap-1">
          {#each view.byProvider as row (row.key)}
            <li class="rounded-lg border border-line/70 bg-canvas/60 px-2 py-1.5 text-[10.5px] leading-4">
              <div class="flex items-baseline justify-between gap-2">
                <span class="font-medium text-ink">{row.key || "desconocido"}</span>
                <span class="tnum text-ink-muted">{formatCost(row.costUsd, row.unknownCostCalls)}</span>
              </div>
              <div class="tnum flex flex-wrap gap-x-2 text-ink-faint">
                <span>{row.calls} llamadas</span>
                <span>· {formatTokens(rowTokens(row))} tokens</span>
                <span>· {formatLatency(row.avgLatencyMs)}</span>
                {#if row.errors}<span class="text-warn">· {row.errors} errores</span>{/if}
                <span>· último uso {formatWhen(row.lastUsedAt)}</span>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="mt-3">
      <h4 class="text-[10px] font-semibold tracking-wider text-ink-faint uppercase">Por modelo</h4>
      {#if !rows(view.byModel).length}
        <p class="mt-1 text-[11px] text-ink-faint">Sin datos.</p>
      {:else}
        <div class="mt-1 overflow-x-auto">
          <table class="w-full min-w-[26rem] border-collapse text-left">
            <thead>
              <tr class="text-[9.5px] tracking-wider text-ink-faint uppercase">
                <th scope="col" class="py-1 pr-2 font-semibold">Modelo</th>
                <th scope="col" class="py-1 pr-2 text-right font-semibold">Llam.</th>
                <th scope="col" class="py-1 pr-2 text-right font-semibold">Ent./Sal.</th>
                <th scope="col" class="py-1 pr-2 text-right font-semibold">Latencia</th>
                <th scope="col" class="py-1 text-right font-semibold">Coste</th>
              </tr>
            </thead>
            <tbody>
              {#each view.byModel as row (row.key)}
                <tr class="border-t border-line/60 text-[10.5px] text-ink-muted">
                  <td class="py-1 pr-2 font-mono text-[10px] break-all text-ink">{row.key}</td>
                  <td class="tnum py-1 pr-2 text-right">{row.calls}</td>
                  <td class="tnum py-1 pr-2 text-right">{formatTokens(row.inputTokens)}/{formatTokens(row.outputTokens)}</td>
                  <td class="tnum py-1 pr-2 text-right">{formatLatency(row.avgLatencyMs)}</td>
                  <td class="tnum py-1 text-right {row.costUsd === null ? 'text-ink-faint italic' : 'text-ink'}">
                    {formatCost(row.costUsd, row.unknownCostCalls)}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}
</section>