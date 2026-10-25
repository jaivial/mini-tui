<script lang="ts" generics="T extends string">
  /** Segmented sidebar filter with counts kept quiet until their tab is active. */
  let {
    items,
    value,
    counts,
    onchange,
  }: {
    items: readonly { id: T; label: string }[];
    value: T;
    counts: Record<T, number>;
    onchange: (id: T) => void;
  } = $props();
</script>

<div class="sidebar-filters grid grid-flow-col auto-cols-fr gap-0.5 rounded-[10px] border border-line/70 bg-canvas/55 p-1" role="tablist" aria-label="Filter tasks">
  {#each items as item (item.id)}
    <button
      type="button"
      role="tab"
      aria-selected={value === item.id}
      class="interactive relative flex min-h-8 cursor-pointer items-center justify-center gap-1.5 rounded-[7px] px-1.5 text-[10.5px] font-medium pointer-coarse:min-h-10
        {value === item.id ? 'bg-raised text-ink shadow-sm' : 'text-ink-muted hover:bg-raised/45 hover:text-ink'}"
      onclick={() => onchange(item.id)}
    >
      <span>{item.label}</span>
      <span class="tnum rounded px-1 text-[9px] {value === item.id ? 'bg-brand-soft text-brand-fg' : 'text-ink-faint'}">{counts[item.id]}</span>
    </button>
  {/each}
</div>

<style>
  .sidebar-filters [aria-selected="true"] { box-shadow: inset 0 0 0 1px var(--color-line), 0 2px 8px rgb(0 0 0 / 0.12); }
</style>
