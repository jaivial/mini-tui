<script lang="ts">
  import type { Snippet } from "svelte";
  import { Activity, ListTodo, Maximize2, Minimize2, X } from "@lucide/svelte";
  import Button from "../Button.svelte";

  /** App-specific sidebar frame: quiet hierarchy, one branded mark and compact utility actions. */
  let {
    running = 0,
    concurrency = 0,
    full = false,
    onfull,
    onclose,
    filters,
    children,
  }: {
    running?: number;
    concurrency?: number;
    full?: boolean;
    onfull?: () => void;
    onclose?: () => void;
    filters?: Snippet;
    children?: Snippet;
  } = $props();
</script>

<aside class="sidebar-shell flex h-full min-h-0 w-full flex-col border-l border-line/80 bg-surface" aria-label="Tasks">
  <header class="sidebar-header relative flex min-h-16 shrink-0 items-center gap-2.5 border-b border-line/80 px-4">
    <span class="sidebar-mark grid size-8 shrink-0 place-items-center rounded-[10px] border border-brand/25 bg-brand-soft text-brand-fg">
      <ListTodo size={15} strokeWidth={1.9} aria-hidden="true" />
    </span>
    <div class="min-w-0 flex-1">
      <h2 class="font-display text-[13px] font-semibold tracking-[-0.01em] text-ink">Work queue</h2>
      <p class="mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-faint">
        <Activity size={10} class={running ? "text-brand-fg" : ""} aria-hidden="true" />
        <span class="tnum">{running}/{concurrency || "—"}</span><span>active workers</span>
      </p>
    </div>
    <div class="flex items-center gap-0.5">
      {#if onfull}<Button variant="ghost" size="icon-sm" icon={full ? Minimize2 : Maximize2} title={full ? "Exit full screen (Esc · Ctrl/⌘ ⇧ F)" : "Full screen (Ctrl/⌘ ⇧ F)"} aria-label={full ? "Exit full screen" : "Full screen"} aria-pressed={full} onclick={onfull} />{/if}
      {#if onclose}<Button variant="ghost" size="icon-sm" icon={X} aria-label="Hide tasks" title="Hide tasks" onclick={onclose} />{/if}
    </div>
  </header>
  {#if filters}<div class="shrink-0 border-b border-line/70 px-3 py-2.5">{@render filters()}</div>{/if}
  <div class="sidebar-content min-h-0 flex-1 overflow-y-auto overscroll-contain">{@render children?.()}</div>
</aside>

<style>
  .sidebar-shell {
    background-image: linear-gradient(180deg, color-mix(in oklab, var(--color-brand) 2.5%, transparent), transparent 11rem);
  }
  .sidebar-mark { box-shadow: inset 0 1px 0 color-mix(in oklab, var(--color-brand) 15%, transparent); }
  .sidebar-content { scrollbar-width: thin; scrollbar-color: var(--color-line-strong) transparent; }
</style>
