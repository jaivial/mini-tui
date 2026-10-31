<script lang="ts">
  import { untrack } from "svelte";
  import { Folder, FolderGit2, FolderUp, House, Eye, EyeOff, CircleAlert, Clock } from "@lucide/svelte";
  import Button from "./Button.svelte";
  import Skeleton from "./Skeleton.svelte";
  import { api } from "../api";
  import { crumbs, folderLabel, loadRecent, tildify } from "../folderPath";
  import type { FolderListing } from "../types";

  /**
   * A folder browser for the machine a workspace runs on (this one, or a remote host over ssh), so
   * what you pick is a folder the agent can actually open. Shown in place: the folder you are in is
   * the choice, reported through `onnavigate`. Type or paste a path and press Enter to go there;
   * click a folder to open it. Arrows move through the list, Backspace in an empty box goes up.
   */
  let {
    value = "",
    target = "local",
    targetLabel = "this machine",
    onnavigate,
  }: {
    /** Where to start; empty means the machine's default folder. */
    value?: string;
    /** "local" or a host id. */
    target?: string;
    targetLabel?: string;
    onnavigate: (path: string) => void;
  } = $props();

  const uid = $props.id();
  let listing = $state<FolderListing | null>(null);
  let loading = $state(false);
  let error = $state("");
  let query = $state("");
  let showHidden = $state(false);
  let active = $state(-1);
  let seq = 0;
  let home = $state("");
  const recents = $derived(listing ? loadRecent(target).filter((p) => p !== listing?.path) : []);

  // A different machine is a different file system: forget where we were and start at its default.
  $effect(() => {
    target;
    listing = null;
    home = "";
    error = "";
    untrack(() => void go(value || ""));
  });

  async function go(path: string) {
    const mine = ++seq;
    loading = true;
    error = "";
    try {
      const next = await api.folders(path, target);
      if (mine !== seq) return;
      listing = next;
      home = next.home;
      query = "";
      active = -1;
      onnavigate(next.path);
    } catch (e) {
      if (mine !== seq) return;
      error = (e as Error).message;
    } finally {
      if (mine === seq) loading = false;
    }
  }

  /** Browse to `path` (the dialog's own path field drives the browser this way). */
  export function goto(path: string) {
    void go(path);
  }

  const visible = $derived(
    (listing?.entries ?? []).filter((e) => (showHidden || !e.hidden) && (!query.trim() || e.name.toLowerCase().includes(query.trim().toLowerCase()))),
  );
  const hiddenCount = $derived((listing?.entries ?? []).filter((e) => e.hidden).length);
  /** The box doubles as a path box: anything starting with a slash or a ~ is a path to go to. */
  const typedPath = $derived(/^[~/]/.test(query.trim()) ? query.trim() : "");
  const empty = $derived(query === "");

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      active = Math.min(visible.length - 1, active + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(-1, active - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (typedPath) void go(typedPath);
      else if (active >= 0 && visible[active]) void go(visible[active]!.path);
    } else if (event.key === "Backspace" && empty && listing?.parent) {
      event.preventDefault();
      void go(listing.parent);
    }
  }

  $effect(() => {
    if (active < 0) return;
    document.getElementById(`${uid}-f-${active}`)?.scrollIntoView({ block: "nearest" });
  });
</script>

<div role="group" aria-label="Choose a folder on {targetLabel}" class="flex max-h-72 min-h-56 flex-col overflow-hidden rounded-lg border border-line bg-canvas/40">
  <!-- Where you are: crumbs you can click, plus home and up. -->
  <div class="flex min-h-11 shrink-0 items-center gap-1 border-b border-line/80 px-1.5 py-1">
    <Button variant="ghost" size="icon-sm" icon={FolderUp} aria-label="Up one folder" title="Up one folder (Backspace)" disabled={!listing?.parent || loading} onclick={() => listing?.parent && go(listing.parent)} />
    <Button variant="ghost" size="icon-sm" icon={House} aria-label="Home folder" title="Home folder" disabled={loading} onclick={() => go("~")} />
    <nav aria-label="Current folder" class="flex min-w-0 flex-1 items-center overflow-x-auto font-mono text-[11.5px] [scrollbar-width:none]">
      {#if listing}
        {@const trail = crumbs(listing.path, home)}
        {#each trail as c, i (c.path)}
          {#if i > 1 || (i === 1 && trail[0]!.label !== "/")}<span class="px-1 text-ink-faint" aria-hidden="true">/</span>{/if}
          <button
            type="button"
            class="interactive shrink-0 cursor-pointer rounded-sm px-1 py-0.5 hover:bg-raised pointer-coarse:min-h-11 pointer-coarse:min-w-11 {i === trail.length - 1 ? 'font-semibold text-ink' : 'text-ink-muted'}"
            aria-current={i === trail.length - 1 ? "location" : undefined}
            onclick={() => go(c.path)}
          >{c.label}</button>
        {/each}
      {:else}
        <span class="px-1 text-ink-faint">{targetLabel}</span>
      {/if}
    </nav>
  </div>

  <div class="shrink-0 p-2">
    <input
      bind:value={query}
      {onkeydown}
      type="text"
      role="combobox"
      aria-expanded="true"
      aria-controls="{uid}-list"
      aria-activedescendant={active >= 0 ? `${uid}-f-${active}` : undefined}
      aria-label="Filter folders, or type a path and press Enter"
      placeholder="Filter, or type a path like ~/projects"
      autocomplete="off"
      autocapitalize="none"
      spellcheck="false"
      enterkeyhint="go"
      class="h-9 w-full rounded-md border border-line bg-canvas px-2.5 font-mono text-base text-ink placeholder:text-ink-faint focus:border-brand/60 focus:outline-none pointer-coarse:h-11"
    />
    {#if typedPath}
      <p class="mt-1 px-1 text-[11.5px] text-ink-muted">Enter to open <span class="font-mono text-ink">{typedPath}</span></p>
    {/if}
  </div>

  <div class="min-h-24 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5" aria-busy={loading}>
    {#if error}
      <div class="mb-1 flex items-start gap-2 rounded-md bg-err/10 px-2.5 py-2 text-[12px] text-err" role="alert">
        <CircleAlert size={13} strokeWidth={2} class="mt-px shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1">{error}</span>
        <button type="button" class="shrink-0 cursor-pointer font-medium underline underline-offset-2 pointer-coarse:min-h-11" onclick={() => go(listing?.path ?? value ?? "")}>Retry</button>
      </div>
    {/if}
    {#if loading && !listing}
      <div class="flex flex-col gap-1.5 p-1" role="status" aria-label="Loading folders">
        <Skeleton class="h-7" /><Skeleton class="h-7" /><Skeleton class="h-7" /><Skeleton class="h-7" />
      </div>
    {:else if listing}
      {#if recents.length && empty}
        <div class="px-1.5 pt-1 text-[10px] font-semibold tracking-wider text-ink-faint uppercase">Recent</div>
        <ul class="mb-1">
          {#each recents as r (r)}
            <li>
              <button type="button" class="interactive flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left font-mono text-[12px] text-ink-muted hover:bg-raised hover:text-ink pointer-coarse:min-h-11" onclick={() => go(r)} title="Open {r}">
                <Clock size={12} strokeWidth={2} class="shrink-0" aria-hidden="true" /><span class="truncate">{tildify(r, home)}</span>
              </button>
            </li>
          {/each}
        </ul>
        <div class="px-1.5 pt-1 text-[10px] font-semibold tracking-wider text-ink-faint uppercase">In {folderLabel(listing.path, home)}</div>
      {/if}
      <ul id="{uid}-list" role="listbox" aria-label="Folders in {listing.path}">
        {#each visible as entry, i (entry.path)}
          <li
            id="{uid}-f-{i}"
            role="option"
            aria-selected={i === active}
            class="interactive flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[12.5px] pointer-coarse:min-h-11 {i === active ? 'bg-raised text-ink' : 'text-ink hover:bg-raised/60'} {entry.hidden ? 'opacity-70' : ''}"
            onpointermove={() => (active = i)}
            onclick={() => go(entry.path)}
            onkeydown={() => {}}
          >
            {#if entry.git}
              <FolderGit2 size={14} strokeWidth={1.75} class="shrink-0 text-brand-fg" aria-hidden="true" />
            {:else}
              <Folder size={14} strokeWidth={1.75} class="shrink-0 text-ink-faint" aria-hidden="true" />
            {/if}
            <span class="min-w-0 flex-1 truncate">{entry.name}</span>
            {#if entry.git}<span class="shrink-0 text-[10.5px] text-ink-faint">git</span>{/if}
          </li>
        {:else}
          <li class="px-2 py-5 text-center text-[12px] text-ink-muted">
            {query.trim() && !typedPath ? `No folder matches “${query.trim()}”` : "No folders in here"}
          </li>
        {/each}
      </ul>
      {#if listing.truncated}
        <p class="px-2 py-1.5 text-[11px] text-ink-faint">Showing the first 500 folders. Type a path to go further.</p>
      {/if}
    {/if}
  </div>

  {#if hiddenCount}
    <div class="flex shrink-0 items-center gap-2 border-t border-line/80 px-2 py-1">
      <Button variant="ghost" size="sm" icon={showHidden ? EyeOff : Eye} aria-pressed={showHidden} onclick={() => (showHidden = !showHidden)}>
        {showHidden ? "Hide" : "Show"} {hiddenCount} hidden
      </Button>
    </div>
  {/if}
</div>
