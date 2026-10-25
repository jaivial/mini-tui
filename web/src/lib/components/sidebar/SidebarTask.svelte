<script lang="ts">
  import type { Snippet } from "svelte";
  import { ChevronRight, Clock3 } from "@lucide/svelte";
  import type { QueueTask } from "../../types";
  import { slide } from "svelte/transition";
  import { reducedMotion } from "../../motion";
  const still = reducedMotion();

  /** A task row with a status rail, stable metadata and an accessible disclosure button. */
  let {
    task,
    open = false,
    elapsed = "",
    blocker = "",
    label,
    tone,
    ontoggle,
    details,
  }: {
    task: QueueTask;
    open?: boolean;
    elapsed?: string;
    blocker?: string;
    label: string;
    tone: "live" | "neutral" | "ok" | "err" | "warn";
    ontoggle: () => void;
    details?: Snippet;
  } = $props();

  const statusClass = $derived(`status-${tone}`);
</script>

<li class="sidebar-task {statusClass} relative border-b border-line/55" data-task={task.id} data-status={task.status} in:slide={{ duration: still ? 0 : 200 }}>
  <span class="status-rail absolute inset-y-3 left-0 w-0.5 rounded-full" aria-hidden="true"></span>
  <button
    type="button"
    class="task-toggle interactive group flex w-full cursor-pointer items-start gap-2.5 px-3.5 py-3 text-left hover:bg-raised/45"
    aria-expanded={open}
    onclick={ontoggle}
  >
    <span class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md text-ink-faint transition-[transform,background-color,color] duration-200 group-hover:bg-raised group-hover:text-ink {open ? 'rotate-90 bg-raised text-brand' : ''}">
      <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />
    </span>
    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-2">
        <span class="min-w-0 flex-1 truncate text-[12px] font-medium leading-4.5 text-ink">{task.title}</span>
        <span class="status-label inline-flex shrink-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[9px] font-medium">
          <span class="status-dot size-1 rounded-full {tone === 'live' ? 'pulse-live' : ''}"></span>{label}
        </span>
      </span>
      <span class="mt-1 line-clamp-2 block text-[10.5px] leading-4 text-ink-muted">{task.description}</span>
      <span class="mt-1.5 flex items-center gap-2 text-[9.5px] text-ink-faint">
        <span class="tnum font-mono">{task.id}</span>
        {#if elapsed}<span class="inline-flex items-center gap-1"><Clock3 size={9} aria-hidden="true" /><span class="tnum">{elapsed}</span></span>{/if}
      </span>
      {#if task.status === "queued" && blocker}<span class="mt-1 block text-[9.5px] text-ink-faint">Waiting for {blocker} · same folder</span>{/if}
    </span>
  </button>
  {#if open && details}
    <div class="task-details border-t border-line/55 bg-canvas/25">{@render details()}</div>
  {/if}
</li>

<style>
  .status-rail, .status-dot { background: var(--status-color, var(--color-ink-faint)); }
  .status-label { color: var(--status-color, var(--color-ink-muted)); background: color-mix(in oklab, var(--status-color, var(--color-ink-faint)) 9%, transparent); }
  .status-live { --status-color: var(--color-brand); }
  .status-ok { --status-color: var(--color-ok); }
  .status-err { --status-color: var(--color-err); }
  .status-warn { --status-color: var(--color-warn); }
  .status-neutral .status-rail { opacity: 0; }
  .sidebar-task:has(.task-toggle[aria-expanded="true"]) .status-rail { opacity: 1; }
  .task-details { animation: sidebar-detail 180ms var(--ease-standard) both; }
  @keyframes sidebar-detail { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
</style>
