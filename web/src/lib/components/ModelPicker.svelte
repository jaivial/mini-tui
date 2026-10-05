<script lang="ts">
  import { untrack } from "svelte";
  import { Check, ChevronDown, Search } from "@lucide/svelte";
  import Spinner from "./Spinner.svelte";
  import Skeleton from "./Skeleton.svelte";
  import { models } from "../stores/models.svelte";
  import { buildGroups, shortName, step } from "../models";

  /**
   * Model switcher for the prompt bar: a searchable, provider-grouped combobox.
   *
   * Keyboard: type to filter, Up/Down/Home/End to move, Enter to pick, Escape to close (focus
   * returns to the trigger). DOM focus stays in the search field and the highlighted row is
   * announced through `aria-activedescendant`. A model missing from the catalogue can be typed.
   * On a phone the panel is a bottom sheet, and the keyboard is not summoned until you tap search.
   */
  let {
    value = "",
    /** Bindable so `/model` can open the picker from the prompt bar. */
    open = $bindable(false),
    busy = false,
    disabled = false,
    note = "",
    onpick,
  }: {
    value?: string;
    open?: boolean;
    /** A switch is in flight. */
    busy?: boolean;
    disabled?: boolean;
    /** One line of context under the list, e.g. when the change lands. */
    note?: string;
    onpick: (id: string) => void;
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
  const fine = () => typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;

  function show() {
    if (disabled) return;
    open = true;
  }

  function hide(returnFocus = true) {
    open = false;
    if (returnFocus) trigger?.focus();
  }

  // Each time it opens (from the button or from `/model`): fresh query, catalogue loaded, highlight
  // on the current model, focus inside. Only `open` is tracked, so typing never re-runs this.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      query = "";
      void models.load();
      const at = flat.findIndex((o) => o.id === value);
      active = at >= 0 ? at : flat.length ? 0 : -1;
    });
    queueMicrotask(() => (fine() ? search : panel)?.focus());
  });

  // Filtering changes what is under the highlight: re-anchor it on the first match.
  $effect(() => {
    query;
    if (open) active = flat.length ? 0 : -1;
  });

  // Keep the highlighted row in view.
  $effect(() => {
    if (!open || active < 0) return;
    list?.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({ block: "nearest" });
  });

  // Dismiss on an outside press.
  $effect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const t = event.target as Node;
      if (panel?.contains(t) || trigger?.contains(t)) return;
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
      case "ArrowDown":
        event.preventDefault();
        active = step(active, 1, flat.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        active = step(active, -1, flat.length);
        break;
      case "Home":
        if (event.target === search && query) return; // let the caret move in the field
        event.preventDefault();
        active = flat.length ? 0 : -1;
        break;
      case "End":
        if (event.target === search && query) return;
        event.preventDefault();
        active = flat.length - 1;
        break;
      case "Enter":
        event.preventDefault();
        pick(active);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        hide();
        break;
      case "Tab":
        // The panel is a small modal-ish surface: Tab closes it rather than tabbing into the page behind.
        hide(false);
        break;
    }
  }

  function toggle() {
    if (open) hide(false);
    else show();
  }

  // Index of an option across groups, for ids and highlighting.
  const indexOf = (id: string) => flat.findIndex((o) => o.id === id);
</script>

<div class="relative min-w-0 pointer-coarse:min-w-11">
  <button
    bind:this={trigger}
    type="button"
    class="interactive flex h-8 max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium text-ink-muted hover:bg-raised hover:text-ink pointer-coarse:h-11 pointer-coarse:min-w-11 pointer-coarse:px-3"
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls={open ? `${uid}-panel` : undefined}
    aria-label="Model: {label}. Change model"
    {disabled}
    onclick={toggle}
  >
    {#if busy}
      <Spinner size={13} label="Switching model" />
    {/if}
    <span class="truncate font-mono text-[12px]">{label}</span>
    <ChevronDown size={13} strokeWidth={2} class="shrink-0 opacity-60" aria-hidden="true" />
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      bind:this={panel}
      id="{uid}-panel"
      role="dialog"
      aria-label="Choose a model"
      tabindex="-1"
      {onkeydown}
      class="elev-pop enter-pop absolute bottom-full left-0 z-40 mb-2 flex max-h-[min(26rem,calc(65*var(--vh)))] w-[min(22rem,calc(100*var(--vw)-1.5rem))] flex-col overflow-hidden rounded-lg outline-none
        max-sm:fixed max-sm:inset-x-3 max-sm:bottom-[max(0.75rem,env(safe-area-inset-bottom))] max-sm:mb-0 max-sm:w-auto"
    >
      <div class="flex items-center gap-2 border-b border-line px-3">
        <Search size={14} strokeWidth={2} class="shrink-0 text-ink-faint" aria-hidden="true" />
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
          placeholder="Search or type a model id"
          class="h-11 min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
        />
      </div>

      <div bind:this={list} id={listId} role="listbox" aria-label="Models" class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
        {#if models.status === "loading" && !models.list.length}
          <div class="flex flex-col gap-1.5 p-2" role="status" aria-label="Loading models">
            <Skeleton class="h-9" />
            <Skeleton class="h-9" />
            <Skeleton class="h-9" />
          </div>
        {:else}
          {#each built.groups as group (group.provider)}
            <div role="group" aria-label={group.provider}>
              <div class="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-ink-faint uppercase" aria-hidden="true">{group.provider}</div>
              {#each group.options as option (option.id)}
                {@const i = indexOf(option.id)}
                <button
                  type="button"
                  id={optionId(i)}
                  role="option"
                  tabindex="-1"
                  aria-selected={option.id === value}
                  class="interactive flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left pointer-coarse:min-h-11
                    {i === active ? 'bg-raised' : ''}"
                  onpointermove={() => (active = i)}
                  onclick={() => pick(i)}
                >
                  <span class="min-w-0 flex-1">
                    <span class="block truncate font-mono text-[12.5px] {option.id === value ? 'font-semibold text-ink' : 'text-ink'}">{option.name}</span>
                    <span
                      class="block truncate text-[11.5px] {option.description.includes('NOT SERVED')
                        ? 'text-warn'
                        : 'text-ink-muted'}"
                      title={option.description}>{option.description}</span>
                  </span>
                  {#if option.id === value}
                    <Check size={14} strokeWidth={2.5} class="shrink-0 text-brand" aria-hidden="true" />
                    <span class="sr-only">current</span>
                  {/if}
                </button>
              {/each}
            </div>
          {:else}
            <div class="px-3 py-6 text-center text-[12.5px] text-ink-muted" role="status">
              {#if models.status === "error"}
                Could not load the model list.
                <button type="button" class="mt-2 block w-full cursor-pointer text-brand underline underline-offset-2" onclick={() => models.load(true)}>Retry</button>
              {:else}
                No model matches “{query}”.
              {/if}
            </div>
          {/each}
        {/if}
      </div>

      {#if note}
        <div class="border-t border-line px-3 py-2 text-[11.5px] text-ink-muted">{note}</div>
      {/if}
    </div>
  {/if}
</div>
