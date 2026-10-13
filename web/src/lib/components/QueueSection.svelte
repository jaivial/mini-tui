<script lang="ts">
  import { QueueEventsClient, type QueueView } from "../queueEventsClient";
  let { open = false }: { open?: boolean } = $props();
  const client = new QueueEventsClient();
  let view = $state<QueueView>({ nodes: [], edges: [] });
  let error = $state("");
  let loaded = $state(false);
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
        <details class="rounded-md border border-line/70 px-2 py-1.5">
          <summary class="cursor-pointer text-[11.5px] leading-5">
            <span class="block break-words font-medium text-ink">{node.project} / {node.id}</span>
            <span class="block text-[10.5px] {node.status === 'done' ? 'text-ok' : node.status === 'blocked' || node.status === 'interrupted' ? 'text-warn' : 'text-ink-muted'}">{label(node.status)} · v{node.goal_version}</span>
            <span class="line-clamp-2 block break-words text-ink-muted">{node.goal}</span>
          </summary>
          <p class="mt-1 whitespace-pre-wrap break-words text-[11px] leading-5 text-ink-muted">{node.goal}</p>
          {#if deps.length}<p class="mt-1 break-words text-[10.5px] text-ink-faint">Depends on: {deps.join(", ")}</p>{/if}
          <p class="mt-1 text-[10px] text-ink-faint">Fence {node.fence}</p>
          {#if node.result}<pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[10.5px] leading-4 text-ink-muted">{node.result}</pre>{/if}
        </details>
      {/each}
    </div>
  {/if}
</section>
