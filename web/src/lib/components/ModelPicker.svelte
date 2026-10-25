<script lang="ts">
  import { untrack } from "svelte";
  import { BrainCircuit, Check, ChevronDown, ExternalLink, Search, SlidersHorizontal } from "@lucide/svelte";
  import Spinner from "./Spinner.svelte";
  import Skeleton from "./Skeleton.svelte";
  import { models } from "../stores/models.svelte";
  import { buildGroups, shortName, step } from "../models";
  import { EFFORT_HINTS, EFFORT_LABELS, selectedEffort, type EffortLevel } from "../../../../src/effort";

  /** Searchable model combobox with a model-specific reasoning-effort editor. */
  let {
    value = "",
    open = $bindable(false),
    busy = false,
    disabled = false,
    note = "",
    efforts = {},
    effortBusy = false,
    onpick,
    oneffort,
  }: {
    value?: string;
    open?: boolean;
    busy?: boolean;
    disabled?: boolean;
    note?: string;
    efforts?: Partial<Record<string, EffortLevel>>;
    effortBusy?: boolean;
    onpick: (id: string) => void;
    oneffort?: (model: string, effort: EffortLevel) => void;
  } = $props();

  const uid = $props.id();
  const listId = `${uid}-list`;
  let query = $state("");
  let active = $state(-1);
  let trigger = $state<HTMLButtonElement | null>(null);
  let panel = $state<HTMLDivElement | null>(null);
  let search = $state<HTMLInputElement | null>(null);
  let list = $state<HTMLDivElement | null>(null);

  const built = $derived(buildGroups(models.list, query, value));
  const flat = $derived(built.flat);
  const optionId = (i: number) => `${uid}-opt-${i}`;
  const label = $derived(value ? shortName(value) : "Default model");
  const currentEffort = $derived(value ? selectedEffort(value, efforts) : "auto");
  const activeOption = $derived(flat[active] ?? flat.find((option) => option.id === value));
  const activeInfo = $derived(activeOption ? models.list.find((model) => model.id === activeOption.id) : undefined);
  const capability = $derived(activeInfo?.effort);
  const activeEffort = $derived(activeOption ? selectedEffort(activeOption.id, efforts) : "auto");
  const fine = () => typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;

  function show() { if (!disabled) open = true; }
  function hide(returnFocus = true) { open = false; if (returnFocus) trigger?.focus(); }

  $effect(() => {
    if (!open) return;
    untrack(() => {
      query = "";
      void models.load();
      const at = flat.findIndex((option) => option.id === value);
      active = at >= 0 ? at : flat.length ? 0 : -1;
    });
    queueMicrotask(() => (fine() ? search : panel)?.focus());
  });
  $effect(() => { query; if (open) active = flat.length ? 0 : -1; });
  $effect(() => {
    if (!open || active < 0) return;
    list?.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({ block: "nearest" });
  });
  $effect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel?.contains(target) || trigger?.contains(target)) return;
      hide(false);
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  });

  function pick(index: number) {
    const option = flat[index];
    if (!option) return;
    hide();
    if (option.id !== value) onpick(option.id);
  }
  function onkeydown(event: KeyboardEvent) {
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); active = step(active, 1, flat.length); break;
      case "ArrowUp": event.preventDefault(); active = step(active, -1, flat.length); break;
      case "Home":
        if (event.target === search && query) return;
        event.preventDefault(); active = flat.length ? 0 : -1; break;
      case "End":
        if (event.target === search && query) return;
        event.preventDefault(); active = flat.length - 1; break;
      case "Enter": event.preventDefault(); pick(active); break;
      case "Escape": event.preventDefault(); event.stopPropagation(); hide(); break;
      case "Tab": hide(false); break;
    }
  }
  const indexOf = (id: string) => flat.findIndex((option) => option.id === id);
</script>

<div class="relative min-w-0 pointer-coarse:min-w-11">
  <button
    bind:this={trigger}
    type="button"
    class="model-trigger interactive flex h-9 max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-line/70 bg-canvas/45 px-2.5 text-left text-ink-muted hover:border-line-strong hover:bg-raised hover:text-ink pointer-coarse:h-11 pointer-coarse:min-w-11 pointer-coarse:px-3"
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls={open ? `${uid}-panel` : undefined}
    aria-label="Model: {label}. Change model"
    {disabled}
    onclick={() => (open ? hide(false) : show())}
  >
    {#if busy}<Spinner size={13} label="Switching model" />{:else}<BrainCircuit size={14} strokeWidth={1.8} class="shrink-0 text-brand" aria-hidden="true" />{/if}
    <span class="min-w-0">
      <span class="block truncate font-mono text-[11.5px] leading-3.5">{label}</span>
      {#if value && currentEffort !== "auto"}<span class="block text-[9.5px] leading-3 text-brand">{EFFORT_LABELS[currentEffort]} effort</span>{/if}
    </span>
    <ChevronDown size={13} strokeWidth={2} class="shrink-0 opacity-60 transition-transform {open ? 'rotate-180' : ''}" aria-hidden="true" />
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      bind:this={panel}
      id="{uid}-panel"
      role="dialog"
      aria-label="Choose a model and reasoning effort"
      tabindex="-1"
      {onkeydown}
      class="model-popover elev-pop enter-pop absolute bottom-full left-0 z-40 mb-2 flex max-h-[min(34rem,calc(78*var(--vh)))] w-[min(27rem,calc(100*var(--vw)-1.5rem))] flex-col overflow-hidden rounded-2xl outline-none max-sm:fixed max-sm:inset-x-3 max-sm:bottom-[max(0.75rem,env(safe-area-inset-bottom))] max-sm:mb-0 max-sm:w-auto"
    >
      <div class="flex items-center gap-2.5 border-b border-line/80 bg-canvas/35 px-3.5">
        <Search size={15} strokeWidth={1.8} class="shrink-0 text-ink-faint" aria-hidden="true" />
        <input
          bind:this={search}
          bind:value={query}
          type="text"
          role="combobox"
          aria-label="Search models, or type a model id"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          autocomplete="off"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          enterkeyhint="go"
          placeholder="Search models or providers"
          class="h-12 min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
        />
        <kbd class="rounded border border-line bg-raised px-1.5 py-0.5 font-sans text-[9px] text-ink-faint">ESC</kbd>
      </div>

      <div bind:this={list} id={listId} role="listbox" aria-label="Models" class="model-list min-h-24 flex-1 overflow-y-auto overscroll-contain p-1.5">
        {#if models.status === "loading" && !models.list.length}
          <div class="flex flex-col gap-1.5 p-2" role="status" aria-label="Loading models"><Skeleton class="h-11" /><Skeleton class="h-11" /><Skeleton class="h-11" /></div>
        {:else}
          {#each built.groups as group (group.provider)}
            <div role="group" aria-label={group.provider}>
              <div class="flex items-center gap-2 px-2.5 pt-3 pb-1.5" aria-hidden="true">
                <span class="text-[9.5px] font-semibold tracking-[0.14em] text-ink-faint uppercase">{group.provider}</span>
                <span class="h-px flex-1 bg-line/70"></span><span class="tnum text-[9px] text-ink-faint">{group.options.length}</span>
              </div>
              {#each group.options as option (option.id)}
                {@const i = indexOf(option.id)}
                <button
                  type="button"
                  id={optionId(i)}
                  role="option"
                  tabindex="-1"
                  aria-selected={option.id === value}
                  class="model-option interactive group relative flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left pointer-coarse:min-h-12
                    {i === active ? 'border-line/80 bg-raised' : 'hover:bg-raised/55'} {option.id === value ? 'is-current' : ''}"
                  onpointermove={() => (active = i)}
                  onfocus={() => (active = i)}
                  onclick={() => pick(i)}
                >
                  <span class="grid size-6 shrink-0 place-items-center rounded-md border border-line/70 bg-canvas/60 text-ink-faint group-hover:text-brand">
                    {#if option.id === value}<Check size={13} strokeWidth={2.4} class="text-brand" aria-hidden="true" />{:else}<span class="size-1 rounded-full bg-current opacity-55"></span>{/if}
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate font-mono text-[12px] font-medium text-ink">{option.name}</span>
                    <span class="block truncate text-[10.5px] {option.description.includes('NOT SERVED') ? 'text-warn' : 'text-ink-muted'}" title={option.description}>{option.description}</span>
                  </span>
                  {#if option.id === value}<span class="sr-only">current</span>{/if}
                </button>
              {/each}
            </div>
          {:else}
            <div class="px-3 py-8 text-center text-[12.5px] text-ink-muted" role="status">
              {#if models.status === "error"}
                Could not load the model list.<button type="button" class="mt-2 block w-full cursor-pointer text-brand underline underline-offset-2" onclick={() => models.load(true)}>Retry</button>
              {:else}No model matches “{query}”.{/if}
            </div>
          {/each}
        {/if}
      </div>

      {#if activeOption}
        <section class="shrink-0 border-t border-line/80 bg-canvas/45 px-3.5 py-3" aria-label="Reasoning effort for {activeOption.name}" onkeydown={(event) => event.stopPropagation()}>
          <div class="mb-2 flex items-center gap-2">
            <SlidersHorizontal size={13} strokeWidth={1.8} class="text-brand" aria-hidden="true" />
            <h3 class="text-[11px] font-semibold text-ink">Reasoning effort</h3>
            <span class="max-w-36 truncate font-mono text-[9.5px] text-ink-faint">{activeOption.name}</span>
            {#if effortBusy}<Spinner size={11} label="Saving effort" />{/if}
            {#if capability?.source}<a href={capability.source} target="_blank" rel="noreferrer" class="ml-auto grid size-6 place-items-center rounded text-ink-faint hover:bg-raised hover:text-brand" aria-label="Read the provider's effort documentation" title="Provider documentation"><ExternalLink size={12} /></a>{/if}
          </div>
          {#if capability?.levels.length}
            <div class="effort-options flex flex-wrap gap-1" role="group" aria-label="Effort level">
              {#each ["auto", ...capability.levels] as EffortLevel[] as level (level)}
                <button
                  type="button"
                  class="effort-chip interactive min-h-7 cursor-pointer rounded-md border px-2 py-1 text-[10.5px] font-medium pointer-coarse:min-h-9
                    {activeEffort === level ? 'border-brand/45 bg-brand-soft text-brand' : 'border-line/80 bg-surface/60 text-ink-muted hover:border-line-strong hover:text-ink'}"
                  aria-pressed={activeEffort === level}
                  title={EFFORT_HINTS[level]}
                  disabled={effortBusy || !oneffort}
                  onclick={() => oneffort?.(activeOption.id, level)}
                >{EFFORT_LABELS[level]}</button>
              {/each}
            </div>
            <p class="mt-2 text-[10px] leading-4 text-ink-faint">{EFFORT_HINTS[activeEffort]}{capability.defaultEffort ? ` · Provider default: ${EFFORT_LABELS[capability.defaultEffort]}` : ""}</p>
          {:else}
            <p class="text-[10.5px] leading-4 text-ink-muted">This model has no documented effort control. Auto keeps its native behaviour.</p>
          {/if}
          {#if capability?.note}<p class="mt-1 text-[10px] leading-4 text-ink-faint">{capability.note}</p>{/if}
        </section>
      {/if}
      {#if note}<div class="border-t border-line/70 px-3.5 py-2 text-[10.5px] text-ink-faint">{note} Effort is saved per model and applies to new runs.</div>{/if}
    </div>
  {/if}
</div>

<style>
  .model-popover { --pop-origin: bottom left; }
  .model-option.is-current { box-shadow: inset 2px 0 0 var(--color-brand); }
  .model-list { scrollbar-width: thin; }
  .effort-chip[aria-pressed="true"] { box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--color-brand) 12%, transparent); }
  @media (max-width: 640px) { .model-popover { --pop-origin: bottom center; } }
</style>
