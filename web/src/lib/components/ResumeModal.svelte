<script lang="ts">
  import { untrack } from "svelte";
  import { Clock, Folder, Search, Trash2 } from "@lucide/svelte";
  import Modal from "./Modal.svelte";
  import Skeleton from "./Skeleton.svelte";
  import Spinner from "./Spinner.svelte";
  import Button from "./Button.svelte";
  import Badge from "./Badge.svelte";
  import { history } from "../stores/history.svelte";
  import { groupByRecency, shortFolder, shortModel, unresumableReason } from "../resume";
  import { relativeTime, cost as money } from "../format";
  import { step } from "../models";
  import type { HistoryItem } from "../types";

  /**
   * Resume: every session saved in the database, whether or not this browser ever opened it. Type to
   * search (title, task and folder), arrows to move, Enter to open. Focus stays in the search field and the
   * highlighted row is announced through `aria-activedescendant`, as in the model picker. Deleting is a
   * separate, confirmed action: opening and closing never remove anything.
   */
  let {
    open = $bindable(false),
    opening = "",
    onopen,
    ondelete,
  }: {
    open?: boolean;
    /** Id of the row being opened right now (shows a spinner and blocks a second open). */
    opening?: string;
    onopen: (item: HistoryItem) => void;
    ondelete: (item: HistoryItem) => Promise<void>;
  } = $props();

  const uid = $props.id();
  const listId = `${uid}-list`;
  let query = $state("");
  let active = $state(0);
  let confirming = $state("");
  let deleting = $state("");
  let search = $state<HTMLInputElement | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const groups = $derived(groupByRecency(history.items));
  const flat = $derived(groups.flatMap((g) => g.items));
  const rowId = (i: number) => `${uid}-row-${i}`;
  const indexOf = (id: string) => flat.findIndex((r) => r.id === id);

  // Opening the panel: a fresh, unfiltered list, and focus in the search field.
  // `untrack`: this effect must run when the panel opens and only then. It used to read the store
  // (through `load`) and so re-ran on every store change, resetting the search to empty the moment a
  // result arrived: now that the sidebar keeps history fresh, that happened on every refresh.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      query = "";
      confirming = "";
      active = 0;
      void history.load("");
    });
    queueMicrotask(() => search?.focus());
    return () => clearTimeout(timer);
  });

  // Typing searches after a short pause: the server is asked once per pause, not once per key.
  function oninput() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      active = 0;
      void history.load(query);
    }, 180);
  }

  $effect(() => {
    flat.length;
    if (active >= flat.length) active = Math.max(0, flat.length - 1);
  });
  $effect(() => {
    if (!open || !flat.length) return;
    document.getElementById(rowId(active))?.scrollIntoView({ block: "nearest" });
  });

  function onkeydown(event: KeyboardEvent) {
    if (confirming) return; // the confirmation owns the keys until it is answered
    if (event.key === "ArrowDown") {
      event.preventDefault();
      active = step(active, 1, flat.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = step(active, -1, flat.length);
    } else if (event.key === "Enter") {
      const item = flat[active];
      if (!item) return;
      event.preventDefault();
      if (!opening) onopen(item);
    }
  }

  async function confirmDelete(item: HistoryItem) {
    deleting = item.id;
    try {
      await ondelete(item);
    } finally {
      deleting = "";
      confirming = "";
    }
  }
</script>

<Modal bind:open title="Resume a session" description="Every session saved on this machine, including ones started in the terminal." width="max-w-2xl" onclose={() => (open = false)}>
  <div class="flex flex-col gap-3" {onkeydown} role="presentation">
    <div class="relative">
      <Search size={15} strokeWidth={2} class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
      <input
        bind:this={search}
        bind:value={query}
        {oninput}
        type="search"
        role="combobox"
        aria-label="Search sessions by title, task or folder"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={flat.length ? rowId(active) : undefined}
        autocomplete="off"
        autocapitalize="none"
        spellcheck="false"
        enterkeyhint="search"
        placeholder="Search by title, task or folder"
        class="h-11 w-full rounded-md border border-line-strong bg-canvas pr-3 pl-9 text-base text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none"
      />
    </div>

    <div class="min-h-[12rem]" aria-live="polite" aria-busy={history.status === "loading"}>
      {#if history.status === "loading" && !history.items.length}
        <div class="flex flex-col gap-2" role="status" aria-label="Loading sessions">
          <Skeleton class="h-16" /><Skeleton class="h-16" /><Skeleton class="h-16" /><Skeleton class="h-16" />
        </div>
      {:else if history.status === "error"}
        <div class="rounded-lg border border-dashed border-line px-4 py-10 text-center" role="alert">
          <p class="text-[13px] text-ink">Could not load your sessions.</p>
          <p class="mt-1 text-[12.5px] text-ink-muted">{history.error}</p>
          <Button class="mt-4" variant="outline" size="sm" onclick={() => history.load(query)}>Try again</Button>
        </div>
      {:else if !flat.length}
        <div class="rounded-lg border border-dashed border-line px-4 py-10 text-center" role="status">
          {#if query.trim()}
            <p class="text-[13px] text-ink">No session matches “{query.trim()}”.</p>
            <p class="mt-1 text-[12.5px] text-ink-muted">Search looks at the title, the first message and the folder.</p>
          {:else}
            <p class="text-[13px] text-ink">No saved sessions yet.</p>
            <p class="mt-1 text-[12.5px] text-ink-muted">Send a message and it will be here next time.</p>
          {/if}
        </div>
      {:else}
        <div id={listId} role="listbox" aria-label="Saved sessions" class="flex flex-col gap-4">
          {#each groups as group (group.bucket)}
            <div role="group" aria-label={group.bucket}>
              <div class="mb-1 flex items-center gap-1.5 px-1 text-[11px] font-semibold tracking-wider text-ink-faint uppercase" aria-hidden="true">
                <Clock size={11} strokeWidth={2} />{group.bucket}
              </div>
              <ul class="flex flex-col gap-1">
                {#each group.items as item (item.id)}
                  {@const i = indexOf(item.id)}
                  {@const reason = unresumableReason(item)}
                  <li class="relative">
                    {#if confirming === item.id}
                      <div class="flex flex-col gap-2 rounded-lg border border-err/40 bg-err/5 p-3" role="alertdialog" aria-label="Delete {item.title}?">
                        <p class="text-[13px] text-ink">Delete “{item.title}” for good? The saved conversation is removed and cannot be brought back.</p>
                        <div class="flex justify-end gap-2">
                          <Button variant="ghost" size="sm" onclick={() => (confirming = "")} disabled={deleting === item.id}>Keep it</Button>
                          <Button variant="danger" size="sm" icon={Trash2} loading={deleting === item.id} onclick={() => confirmDelete(item)}>Delete</Button>
                        </div>
                      </div>
                    {:else}
                      <div
                        id={rowId(i)}
                        role="option"
                        tabindex="-1"
                        aria-selected={i === active}
                        aria-label="{item.title}. {shortFolder(item.cwd)}. {relativeTime(item.updatedAt)}.{item.open ? ' Already open.' : ''}{reason ? ' Read only.' : ''}"
                        class="interactive flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2 pr-14 pointer-coarse:min-h-16 {i === active ? 'border-line bg-raised' : 'hover:bg-raised/60'}"
                        onpointermove={() => (active = i)}
                        onclick={() => !opening && onopen(item)}
                        onkeydown={() => {}}
                      >
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2">
                            <span class="truncate text-[13.5px] font-medium text-ink">{item.title || "Untitled"}</span>
                            {#if opening === item.id}<Spinner size={13} label="Opening" />{/if}
                            {#if item.open}<Badge tone="brand">open</Badge>{/if}
                            {#if reason}<Badge tone="neutral">read only</Badge>{/if}
                          </div>
                          <div class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-ink-muted">
                            <Folder size={11} strokeWidth={1.75} class="shrink-0" aria-hidden="true" />
                            <span class="truncate font-mono">{shortFolder(item.cwd)}</span>
                            <span aria-hidden="true">·</span>
                            <span class="shrink-0 truncate">{shortModel(item.model)}</span>
                            <span aria-hidden="true">·</span>
                            <span class="tnum shrink-0">{relativeTime(item.updatedAt)}</span>
                            {#if item.cost > 0}<span aria-hidden="true">·</span><span class="tnum shrink-0">{money(item.cost)}</span>{/if}
                          </div>
                        </div>
                      </div>
                      <div class="absolute top-1/2 right-1.5 -translate-y-1/2">
                        <Button variant="ghost" size="icon-sm" icon={Trash2} aria-label="Delete {item.title}" title="Delete" onclick={() => (confirming = item.id)} />
                      </div>
                    {/if}
                  </li>
                {/each}
              </ul>
            </div>
          {/each}
          {#if history.capped}
            <p class="px-1 text-center text-[12px] text-ink-muted">Showing the {history.items.length} most recent. Search to find an older one.</p>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</Modal>
