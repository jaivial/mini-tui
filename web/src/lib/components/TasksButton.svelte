<script lang="ts">
  import { Check, ListChecks } from "@lucide/svelte";
  import Popover from "./Popover.svelte";
  import { paneRowLabel, paneSummary, type WindowTasks } from "../tasks";

  /**
   * A window's tasks, in the sidebar's own window row: one icon per window, and the popover it opens
   * is a portal card floating over the panes.
   *
   * The card is titled with the window's general task, and every pane of that window is a row inside
   * it. Hovering a row opens a second, smaller card against that row with what that pane is doing —
   * its task card, its description and its to-dos — so one window's worth of work is readable without
   * leaving the sidebar. The click still opens the full board (the drawer with every session), and the
   * icon's badge counts how many of this window's panes hold a task.
   */
  let {
    tasks,
    onopen,
  }: {
    /** This window's panes and their tasks, as `lib/tasks.ts` groups them. */
    tasks: WindowTasks;
    /** Open the full board (the drawer with every session's card). */
    onopen: () => void;
  } = $props();

  let open = $state(false);
  /** The pane whose own card is showing, by pane number; 0 while none is. */
  let peek = $state(0);
  let button = $state<HTMLElement | null>(null);
  let row = $state<HTMLElement | null>(null);
  /**
   * A press with a pointer is already going to be a click, so its focus must not be read as the
   * keyboard asking for the card — otherwise the focus opens it and the click that follows closes it.
   */
  let viaPointer = false;

  /** The icon's badge: how many of this window's panes hold a task. */
  const count = $derived(tasks.withTask);
  /** The pane the peek card is about, or null while it is closed. */
  const peeked = $derived(tasks.panes[peek - 1] ?? null);

  /** Hovering (or focusing) a pane row opens that pane's own card, placed against the row itself. */
  function showPeek(n: number, el: HTMLElement) {
    row = el;
    peek = n;
  }
</script>

<button
  type="button"
  bind:this={button}
  class="interactive relative grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm
    {count ? 'text-ink-muted hover:text-ink' : 'text-ink-faint hover:text-ink'} pointer-coarse:size-11"
  aria-label="Tasks of {tasks.window}"
  title="Tasks of {tasks.window}"
  aria-expanded={open}
  onpointerdown={() => (viaPointer = true)}
  onclick={() => (open = !open)}
  onfocus={() => !viaPointer && (open = true)}
  onblur={() => (viaPointer = false)}
>
  <ListChecks size={12} strokeWidth={2} aria-hidden="true" />
  {#if count}
    <span class="tnum absolute -top-0.5 -right-0.5 rounded-full bg-brand px-1 text-[8.5px] leading-[11px] font-semibold text-canvas" title="{count} of {tasks.panes.length} panes have a task">
      {count}
    </span>
  {/if}
</button>

<Popover open={open} anchor={() => button} placement="right" label="Tasks of {tasks.window}" onclose={() => { open = false; peek = 0; }}>
  <div class="px-1 pb-1.5">
    <!-- The title is the window's general task: the one line saying what this whole window is for. -->
    <div class="truncate text-[11.5px] leading-4 font-semibold text-ink" title={tasks.title}>{tasks.title}</div>
    <div class="text-[10px] tracking-wider text-ink-faint uppercase">{tasks.window}</div>
  </div>

  <!-- The rows are a list of the window's panes: the label says so, and the list is announced. -->
  <ul class="flex flex-col" aria-label="Panes of {tasks.window}" onmouseleave={() => (peek = 0)}>
    {#each tasks.panes as pane (pane.pane)}
      <!--
        One row per pane, and that pane's own card opens on hover (and on focus, so the keyboard
        reaches it too). The row is a button, not a div: it is the one thing a pointer asks for here.
      -->
      <li>
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-left {peek === pane.pane ? 'bg-overlay' : 'hover:bg-overlay/60'}"
          aria-label="Pane {pane.pane}: {paneRowLabel(pane)}"
          title={paneRowLabel(pane)}
          aria-expanded={peek === pane.pane}
          onmouseenter={(e) => showPeek(pane.pane, e.currentTarget as HTMLElement)}
          onfocus={(e) => showPeek(pane.pane, e.currentTarget as HTMLElement)}
        >
          <span class="tnum grid size-4 shrink-0 place-items-center rounded-sm bg-overlay text-[9.5px] font-semibold text-ink-muted">{pane.pane}</span>
          <span class="min-w-0 flex-1 truncate text-[11.5px] leading-4 text-ink">{paneRowLabel(pane)}</span>
          {#if pane.counts}
            <span class="tnum shrink-0 text-[10px] text-ink-faint" title="{pane.counts.done} done, {pane.counts.pending} pending, {pane.counts.left} left">{pane.counts.done}/{pane.counts.done + pane.counts.pending + pane.counts.left}</span>
          {/if}
        </button>
      </li>
    {/each}
  </ul>

  <div class="mt-1 flex items-center justify-between gap-2 border-t border-line/80 px-1 pt-1.5">
    <span class="truncate text-[10px] text-ink-faint">{count ? `${count} of ${tasks.panes.length} panes working` : 'No task card yet'}</span>
    <button
      type="button"
      class="interactive shrink-0 cursor-pointer rounded-sm px-1.5 py-0.5 text-[10.5px] font-medium text-brand hover:bg-overlay"
      onclick={onopen}
    >Open board</button>
  </div>
</Popover>

<!--
  The pane's own card: a second portal, placed against the hovered row. It is drawn in place (the
  Popover places it) and its content is what the hovered pane is doing right now.
-->
{#if peeked}
  <Popover open anchor={() => row} placement="right" width="w-64" label="Pane {peeked.pane} of {tasks.window}">
    <div class="flex items-start gap-1.5 px-1 pb-1.5">
      <span class="tnum mt-px grid size-4 shrink-0 place-items-center rounded-sm bg-overlay text-[9.5px] font-semibold text-ink-muted">{peeked.pane}</span>
      <div class="min-w-0 flex-1">
        <div class="truncate text-[11.5px] leading-4 font-semibold text-ink" title={paneRowLabel(peeked)}>{paneRowLabel(peeked)}</div>
        <div class="truncate text-[10px] leading-4 text-ink-muted">{paneSummary(peeked)}</div>
      </div>
    </div>
    {#if peeked.task}
      {#if peeked.task.description}
        <p class="px-1 pb-1.5 text-[11px] leading-4 text-ink-muted">{peeked.task.description}</p>
      {/if}
      <div class="flex flex-col gap-1 px-1">
        {#each [["done", peeked.task.todos.done], ["pending", peeked.task.todos.pending], ["left", peeked.task.todos.left]] as [kind, items] (kind)}
          {#if items.length}
            <div>
              <div class="text-[9.5px] font-semibold tracking-wider text-ink-faint uppercase">{kind} ({items.length})</div>
              <ul class="mt-0.5 flex flex-col gap-0.5">
                {#each items as item}
                  <li class="flex items-start gap-1 text-[10.5px] leading-4 {kind === 'done' ? 'text-ink-faint line-through' : 'text-ink'}">
                    {#if kind === "done"}
                      <Check size={10} strokeWidth={2.5} class="mt-0.5 shrink-0 text-ok" aria-hidden="true" />
                    {:else}
                      <span class="mt-1.5 size-1.5 shrink-0 rounded-full {kind === 'pending' ? 'bg-warn' : 'border border-line-strong'}" aria-hidden="true"></span>
                    {/if}
                    <span class="min-w-0">{item}</span>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        {/each}
        {#if !peeked.task.description && !peeked.task.todos.done.length && !peeked.task.todos.pending.length && !peeked.task.todos.left.length}
          <p class="px-1 text-[10.5px] leading-4 text-ink-faint">This card has no description or to-dos yet.</p>
        {/if}
      </div>
    {:else}
      <p class="px-1 pb-1 text-[10.5px] leading-4 text-ink-faint">
        This pane has no task card yet. Its agent fills one while it works (<code class="rounded-sm bg-overlay px-1 py-0.5 text-[10px]">mini-tui tasks set</code>).
      </p>
    {/if}
  </Popover>
{/if}
