<script lang="ts">
  /**
   * WAI-ARIA tabs: one tab stop for the whole list (roving tabindex), Left/Right/Home/End move
   * and select, and every tab names its panel. The parent renders the panels with
   * `id="{idBase}-panel-{id}"` and `aria-labelledby="{idBase}-tab-{id}"`.
   */
  let {
    tabs,
    value = $bindable(),
    idBase,
    label,
  }: { tabs: { id: string; label: string }[]; value: string; idBase: string; label: string } = $props();

  let buttons = $state<HTMLButtonElement[]>([]);
  let list = $state<HTMLElement | null>(null);
  /** The indicator follows the active tab's box (left + width), sliding between them. */
  let bar = $state({ left: 0, width: 0, ready: false });
  $effect(() => {
    const at = tabs.findIndex((t) => t.id === value);
    const el = buttons[at];
    if (!el || !list) return;
    const measure = () => (bar = { left: el.offsetLeft, width: el.offsetWidth, ready: true });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => ro.disconnect();
  });

  function onkeydown(event: KeyboardEvent) {
    const at = tabs.findIndex((t) => t.id === value);
    let next = at;
    if (event.key === "ArrowRight") next = (at + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (at - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    value = tabs[next]!.id;
    buttons[next]?.focus();
  }
</script>

<div bind:this={list} role="tablist" aria-label={label} class="relative flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]" {onkeydown} tabindex="-1">
  {#each tabs as tab, i (tab.id)}
    <button
      bind:this={buttons[i]}
      type="button"
      role="tab"
      id="{idBase}-tab-{tab.id}"
      aria-selected={value === tab.id}
      aria-controls="{idBase}-panel-{tab.id}"
      tabindex={value === tab.id ? 0 : -1}
      class="interactive relative min-h-9 shrink-0 cursor-pointer rounded-t-md px-3 text-[13px] font-medium pointer-coarse:min-h-11
        {value === tab.id ? 'text-ink' : 'text-ink-muted hover:bg-raised/60 hover:text-ink'}"
      onclick={() => (value = tab.id)}
    >
      {tab.label}
    </button>
  {/each}
  <span
    aria-hidden="true"
    class="indicator pointer-events-none absolute bottom-0 h-0.5 rounded-full bg-brand"
    class:ready={bar.ready}
    style="transform: translateX({bar.left}px); width: {bar.width}px"
  ></span>
</div>

<style>
  .indicator {
    left: 0;
    opacity: 0;
  }
  .indicator.ready {
    opacity: 1;
    transition:
      transform 320ms cubic-bezier(0.34, 1.3, 0.64, 1),
      width 320ms cubic-bezier(0.34, 1.3, 0.64, 1);
  }
</style>
