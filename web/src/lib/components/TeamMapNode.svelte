<script lang="ts">
  /**
   * One pet on the team map: its squishmoji (the session's stable face), its
   * name and a state badge (the pulsing dot while it works). The current task
   * rides in the tooltip and, when there is room, as a one-line subtitle.
   */
  import { Handle, Position } from "@xyflow/svelte";
  import { avatarSrc } from "../avatar";

  let { data } = $props();

  const DOT: Record<string, string> = {
    live: "var(--color-brand)",
    ok: "var(--color-ok)",
    warn: "var(--color-warn)",
    err: "var(--color-err)",
    wait: "#38bdf8",
    idle: "var(--color-ink-faint)",
  };
  const tone = $derived((data.tone as string) ?? "idle");
  const task = $derived((data.task as string) ?? "");
</script>

<div
  class="pet"
  class:root={(data.root as boolean) ?? false}
  class:live={tone === "live"}
  title={task || (data.name as string)}
>
  <Handle type="target" position={Position.Top} class="handle" />
  <div class="row">
    <span class="face-wrap">
      <img src={avatarSrc(data.avatarId as string)} alt="" aria-hidden="true" draggable="false" class="face" />
      <span class="dot" class:pulse={tone === "live"} style:background={DOT[tone] ?? DOT.idle}></span>
    </span>
    <span class="min-w-0">
      <span class="name">{data.name}</span>
      <span class="badge">{data.label}</span>
    </span>
  </div>
  {#if task}
    <div class="task">{task}</div>
  {/if}
  <Handle type="source" position={Position.Bottom} class="handle" />
</div>

<style>
  .pet {
    width: 158px;
    background: var(--color-surface);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-lg);
    padding: 8px 10px;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.4);
    font-size: 12px;
    color: var(--color-ink);
  }
  .pet.live {
    border-color: var(--color-brand);
    box-shadow: 0 0 0 1px var(--color-brand-soft), 0 1px 2px rgb(0 0 0 / 0.4);
  }
  .pet.root {
    background: var(--color-raised);
    border-style: dashed;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .face-wrap {
    position: relative;
    flex: none;
    width: 30px;
    height: 30px;
  }
  .face {
    width: 100%;
    height: 100%;
    object-fit: contain;
    user-select: none;
  }
  .dot {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1.5px solid var(--color-surface);
  }
  .dot.pulse {
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
  .min-w-0 {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }
  .name {
    overflow: hidden;
    font-weight: 600;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    align-self: flex-start;
    font-size: 9.5px;
    color: var(--color-ink-muted);
    background: var(--color-raised);
    border: 1px solid var(--color-line);
    border-radius: 999px;
    padding: 0 6px;
    line-height: 1.5;
  }
  .task {
    margin-top: 6px;
    color: var(--color-ink-muted);
    font-size: 10.5px;
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .pet :global(.handle) {
    width: 6px;
    height: 6px;
    background: var(--color-line-strong);
    border: none;
  }
</style>
