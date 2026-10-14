<script lang="ts">
  /**
   * Read-only project queue. A registry row is never a worker: "running" is
   * backed by a lease, and its freshness is shown explicitly — a stale lease
   * means the row says running but no worker is proven alive (it needs
   * reconciliation), never a live heartbeat.
   */
  import { QueueEventsClient, type QueueNode, type QueueView } from "../queueEventsClient";
  let { open = false }: { open?: boolean } = $props();
  const client = new QueueEventsClient();
  let view = $state<QueueView>({ nodes: [], edges: [] });
  let error = $state("");
  let loaded = $state(false);
  // Freshness is time-sensitive: re-render the lease lines even when no event arrives.
  let now = $state(Date.now());
  $effect(() => {
    const tick = setInterval(() => { now = Date.now(); }, 15_000);
    return () => clearInterval(tick);
  });
  const counts = $derived(view.nodes.reduce((out,node) => {
    out[node.status] = (out[node.status] ?? 0) + 1; return out;
  },{} as Record<string,number>));
  $effect(() => {
    if (!open) return;
    return client.watch(next => {
      view = next; error = client.error; loaded = client.loaded;
    });
  });
  function label(status: string) {
    return ({pending:"Ready / waiting",running:"Running",blocked:"Blocked",interrupted:"Needs reconciliation",done:"Closed with evidence",cancelled:"Cancelled"} as Record<string,string>)[status] ?? status;
  }
  /** A running row is worker-alive only while its lease is fresh. The registry stores epoch seconds; be tolerant of ms. */
  function lease(node: QueueNode): { fresh: boolean; text: string } | null {
    if (node.status !== "running") return null;
    const raw = typeof node.lease_until === "number" && node.lease_until > 1_000_000_000 ? node.lease_until : null;
    const until = raw === null ? null : raw > 1_000_000_000_000 ? raw : raw * 1000;
    if (until === null) return { fresh: false, text: node.owner ? `Registry says running · owner ${node.owner} · no lease recorded` : "Registry says running · no worker lease recorded" };
    const seconds = Math.round((until - now) / 1000);
    if (seconds > 0) return { fresh: true, text: `Worker lease fresh${node.owner ? ` · ${node.owner}` : ""} · renews for ${formatDuration(seconds)}` };
    return { fresh: false, text: `Registry says running, but the worker lease expired ${formatDuration(-seconds)} ago — no live worker is proven; needs reconciliation` };
  }
  function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
</script>

<section class="mb-3 rounded-lg border border-line bg-raised/40 p-3" aria-label="Project queue">
  <div class="flex items-center justify-between gap-2">
    <h3 class="text-[12.5px] font-medium text-ink">Project queue</h3>
    <span class="text-[10.5px] text-ink-faint">Read-only</span>
  </div>
  {#if error}
    <p role="status" class="mt-2 text-[11.5px] leading-5 text-warn">{error}. Last snapshot retained; reconnecting.</p>
  {:else if !loaded}
    <p role="status" class="mt-2 text-[11.5px] text-ink-muted">Reading queue...</p>
  {:else if !view.nodes.length}
    <p class="mt-2 text-[11.5px] leading-5 text-ink-muted">No queued projects in the local registry.</p>
  {/if}
  {#if view.nodes.length}
    <p class="mt-1 text-[10.5px] leading-5 text-ink-faint">{view.nodes.length} tasks · {counts.running ?? 0} running · {counts.blocked ?? 0} blocked</p>
    <p class="text-[10.5px] leading-5 text-ink-faint">Queue state is not a worker heartbeat. Pending tasks may wait for dependencies.</p>
    <div class="mt-2 flex flex-col gap-1.5">
      {#each view.nodes as node (node.id)}
        {@const deps = view.edges.filter(edge => edge.task === node.id).map(edge => edge.dependency)}
        {@const leaseInfo = lease(node)}
        <details class="rounded-md border border-line/70 px-2 py-1.5">
          <summary class="cursor-pointer text-[11.5px] leading-5">
            <span class="block break-words font-medium text-ink">{node.project} / {node.id}</span>
            <span class="block text-[10.5px] {node.status === 'done' ? 'text-ok' : node.status === 'blocked' || node.status === 'interrupted' ? 'text-warn' : 'text-ink-muted'}">{label(node.status)} · v{node.goal_version}</span>
            <span class="line-clamp-2 block break-words text-ink-muted">{node.goal}</span>
          </summary>
          <p class="mt-1 whitespace-pre-wrap break-words text-[11px] leading-5 text-ink-muted">{node.goal}</p>
          {#if leaseInfo}
            <p class="mt-1 break-words text-[10.5px] {leaseInfo.fresh ? 'text-ok' : 'text-warn'}">{leaseInfo.text}</p>
          {/if}
          {#if deps.length}<p class="mt-1 break-words text-[10.5px] text-ink-faint">Depends on: {deps.join(", ")}</p>{/if}
          <p class="mt-1 text-[10px] text-ink-faint">Fence {node.fence}</p>
          {#if node.result}<pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[10.5px] leading-4 text-ink-muted">{node.result}</pre>{/if}
        </details>
      {/each}
    </div>
  {/if}
</section>
