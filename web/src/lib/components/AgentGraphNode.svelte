<script lang="ts">
  /** One agent in the graph: a shadcn-style card with status dot, name, model and cost. */
  import { Handle, Position } from "@xyflow/svelte";

  let { data } = $props();

  const DOT: Record<string, string> = {
    live: "var(--color-brand)",
    ok: "var(--color-ok)",
    warn: "var(--color-warn)",
    err: "var(--color-err)",
    wait: "#38bdf8",
    idle: "var(--color-ink-faint)",
  };
</script>

<div class="card" class:root={data.root} class:live={data.tone === "live"}>
  <Handle type="target" position={Position.Top} class="handle" />
  <div class="head">
    <span class="dot" class:pulse={data.tone === "live"} style:background={DOT[data.tone as string] ?? DOT.idle}></span>
    <span class="name">{data.name}</span>
    <span class="badge">{data.label}</span>
  </div>
  {#if data.task}
    <div class="task">{data.task}</div>
  {/if}
  {#if !data.root}
    <div class="meta">
      {#if data.model}<span>{data.model}</span>{/if}
      {#if data.steps}<span>{data.steps} steps</span>{/if}
      {#if data.cost}<span>${data.cost.toFixed(3)}</span>{/if}
    </div>
  {/if}
  <Handle type="source" position={Position.Bottom} class="handle" />
</div>

<style>
  .card {
    width: 230px;
    background: var(--color-surface);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-lg);
    padding: 10px 12px;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.4);
    font-size: 12px;
    color: var(--color-ink);
  }
  .card.live {
    border-color: var(--color-brand);
    box-shadow: 0 0 0 1px var(--color-brand-soft), 0 1px 2px rgb(0 0 0 / 0.4);
  }
  .card.root {
    background: var(--color-raised);
    border-style: dashed;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
  }
  .dot.pulse {
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
  .name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .badge {
    flex: none;
    font-size: 10px;
    color: var(--color-ink-muted);
    background: var(--color-raised);
    border: 1px solid var(--color-line);
    border-radius: 999px;
    padding: 1px 8px;
  }
  .task {
    margin-top: 6px;
    color: var(--color-ink-muted);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .meta {
    margin-top: 6px;
    display: flex;
    gap: 10px;
    font-size: 10px;
    color: var(--color-ink-faint);
  }
  .card :global(.handle) {
    width: 6px;
    height: 6px;
    background: var(--color-line-strong);
    border: none;
  }
</style>
