<script lang="ts">
  import type { Completion } from "../completion";

  /**
   * The list under a `/command` or `$skill` being typed. Focus never leaves the textarea: the
   * textarea points at the highlighted row with `aria-activedescendant`, so this is only the
   * listbox. Rows use `pointerdown` + preventDefault so a tap picks without blurring the field
   * (which would close the phone keyboard).
   */
  let {
    completion,
    active,
    id,
    onpick,
    onhover,
  }: {
    completion: Completion;
    active: number;
    id: string;
    onpick: (index: number) => void;
    onhover: (index: number) => void;
  } = $props();

  const rows = $derived(
    completion.kind === "command"
      ? completion.items.map((c) => ({ key: c.name, title: c.insert + (c.args ? ` ${c.args}` : ""), detail: c.detail }))
      : completion.items.map((s) => ({ key: s.name, title: `$${s.name}`, detail: s.description })),
  );

  $effect(() => {
    active;
    document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  });
</script>

<div
  {id}
  role="listbox"
  aria-label={completion.kind === "command" ? "Commands" : "Skills"}
  class="elev-pop enter-pop absolute right-0 bottom-full left-0 z-30 mb-2 max-h-64 overflow-y-auto overscroll-contain rounded-lg p-1"
>
  {#each rows as row, i (row.key)}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      id="{id}-opt-{i}"
      role="option"
      tabindex="-1"
      aria-selected={i === active}
      class="interactive flex min-h-9 cursor-pointer items-baseline gap-3 rounded-md px-2.5 py-1.5 pointer-coarse:min-h-11 pointer-coarse:items-center {i === active ? 'bg-raised' : ''}"
      onpointermove={() => onhover(i)}
      onpointerdown={(event) => {
        event.preventDefault();
        onpick(i);
      }}
    >
      <span class="shrink-0 font-mono text-[12.5px] font-medium text-ink">{row.title}</span>
      <span class="min-w-0 flex-1 truncate text-[12px] text-ink-muted">{row.detail}</span>
    </div>
  {/each}
</div>
