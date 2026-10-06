<script lang="ts">
  import { ListChecks } from "@lucide/svelte";
  import { previewLines, type TaskRow } from "../tasks";

  /**
   * The window's session-tasks button. Hovering it shows a quick glance — which sessions have task
   * cards and how their to-dos stand — but it is the click that opens the panel; the glance is never
   * the only path to anything (and on touch there is no hover at all, just the same click).
   */
  let {
    rows,
    onopen,
  }: {
    rows: TaskRow[];
    onopen: () => void;
  } = $props();

  const glance = $derived(previewLines(rows));

  let hover = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let button = $state<HTMLElement | null>(null);
  let card = $state<HTMLElement | null>(null);
  const at = $derived.by(() => {
    void hover;
    const rect = button?.getBoundingClientRect();
    return rect ? { top: rect.bottom + 6, left: Math.max(8, rect.left - 8) } : null;
  });

  /** A short delay, so sliding the pointer past the button never flashes a card at the user. */
  function enter() {
    clearTimeout(timer);
    timer = setTimeout(() => (hover = true), 180);
  }
  function leave() {
    clearTimeout(timer);
    timer = setTimeout(() => (hover = false), 120);
  }
</script>

<span class="relative flex items-center">
  <button
    type="button"
    bind:this={button}
    class="interactive relative grid size-6 cursor-pointer place-items-center rounded-sm text-ink-faint hover:bg-overlay hover:text-ink pointer-coarse:size-11"
    aria-label="Session tasks"
    title="Session tasks"
    onclick={onopen}
    onmouseenter={enter}
    onmouseleave={leave}
    onfocus={enter}
    onblur={leave}
  >
    <ListChecks size={12} strokeWidth={2} aria-hidden="true" />
    {#if glance.length}
      <span class="tnum absolute -top-0.5 -right-0.5 rounded-full bg-brand px-1 text-[8.5px] leading-[11px] font-semibold text-canvas" title="{glance.length} sessions with task cards">
        {glance.length}
      </span>
    {/if}
  </button>
  {#if hover && glance.length && at}
    <!-- The quick glance: a peek at the board. Opening the panel is what the click is for. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      bind:this={card}
      class="elev-pop enter-pop fixed z-50 w-72 rounded-lg border border-line bg-canvas p-2 text-left shadow-lg"
      style="top: {at.top}px; left: {at.left}px"
      role="tooltip"
      tabindex="0"
      onmouseenter={enter}
      onmouseleave={leave}
    >
      <div class="px-1 pb-1 text-[10px] font-semibold tracking-wider text-ink-faint uppercase">Session tasks</div>
      {#each glance as line (line.title + line.detail)}
        <div class="rounded-sm px-1 py-0.5">
          <div class="truncate text-[11.5px] leading-4 font-medium text-ink">{line.title}</div>
          <div class="truncate text-[10.5px] leading-4 text-ink-muted">{line.detail}</div>
        </div>
      {/each}
      {#if rows.length > glance.length}
        <div class="px-1 pt-0.5 text-[10px] text-ink-faint">and {rows.length - glance.length} more — click to open</div>
      {/if}
    </div>
  {/if}
</span>
