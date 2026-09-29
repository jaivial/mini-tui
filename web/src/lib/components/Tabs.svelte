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

<div role="tablist" aria-label={label} class="flex gap-1 border-b border-line" {onkeydown} tabindex="-1">
  {#each tabs as tab, i (tab.id)}
    <button
      bind:this={buttons[i]}
      type="button"
      role="tab"
      id="{idBase}-tab-{tab.id}"
      aria-selected={value === tab.id}
      aria-controls="{idBase}-panel-{tab.id}"
      tabindex={value === tab.id ? 0 : -1}
      class="interactive -mb-px min-h-9 cursor-pointer border-b-2 px-3 text-[13px] font-medium pointer-coarse:min-h-11
        {value === tab.id ? 'border-brand text-ink' : 'border-transparent text-ink-muted hover:text-ink'}"
      onclick={() => (value = tab.id)}
    >
      {tab.label}
    </button>
  {/each}
</div>
