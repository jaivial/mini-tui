<script lang="ts">
  import { untrack } from "svelte";
  import { Plus, Server, Terminal, ChevronRight, Square, PanelLeftClose, Settings, RotateCcw, AppWindow, AppWindowMac, Layers } from "@lucide/svelte";
  import Spinner from "./Spinner.svelte";
  import { sidebarHistory } from "../stores/history.svelte";
  import { folderStore } from "../stores/folders.svelte";
  import { folderTitle, groupByFolder, isExpanded, loadPrefs, normalizeCwd, savePrefs, toggleIn, type FolderGroup } from "../sessionFolders";
  import { ChevronDown, Pin, PinOff, Folder, FolderPlus, Clock3, FolderTree, Pencil, X } from "@lucide/svelte";
  import { groupByRecency, unresumableReason } from "../resume";
  import type { HistoryItem } from "../types";
  import Button from "./Button.svelte";
  import Badge from "./Badge.svelte";
  import Skeleton from "./Skeleton.svelte";
  import { store } from "../stores/sessions.svelte";
  import { baseName, relativeTime, cost } from "../format";
  import type { SessionState } from "../types";

  let {
    onnew,
    onsettings,
    onopenhosts,
    onhidesidebar,
    onclosesession,
    onopen,
    onopenhistory,
    onresume,
    onnewin,
    inOtherWindow,
    openingId = "",
    windows = [],
    onwindow,
    onnewwindow,
    onrename,
    onclosewindow,
    paneOf = () => 0,
    focusedSession = null,
    loading = false,
    class: klass = "",
  }: {
    onnew: () => void;
    onsettings: () => void;
    onopenhosts: () => void;
    /** Collapse the sidebar itself. */
    onhidesidebar: () => void;
    /** Close one session by id (stop it and drop it from the list). */
    onclosesession: (id: string) => void;
    /** Open a session in the focused pane (or focus the pane already showing it). */
    onopen: (id: string) => void;
    /** Open a saved session (from the database) in the focused pane. */
    onopenhistory: (item: HistoryItem) => void;
    /** Start a new chat in this folder (on this host, when the folder is a remote one). */
    onnewin?: (cwd: string, hostId?: string) => void;
    /** The full Resume panel (search everything, delete). */
    onresume: () => void;
    /** A saved session being opened right now. */
    openingId?: string;
    /** Every window, in order, with its pane count and which is on screen. */
    windows?: { id: string; label: string; name: string | null; panes: number; active: boolean }[];
    /** Show a window. */
    onwindow?: (id: string) => void;
    /** Start a new, empty window. */
    onnewwindow?: () => void;
    /** Rename a window (an empty name goes back to "Window 3"). */
    onrename?: (id: string, name: string) => void;
    /** Close a window. Only one with no panes can go; the button says so otherwise. */
    onclosewindow?: (id: string) => void;

    /** The window holding a session that no pane on screen shows, or "" when one does. */
    inOtherWindow?: (id: string) => string;
    /** Number of the pane showing a session, 0 when none: shown on the row when there are panes. */
    paneOf?: (id: string) => number;
    /** The session in the focused pane: that row is the highlighted one. */
    focusedSession?: string | null;
    /** The first session list is still on its way. */
    loading?: boolean;
    class?: string;
  } = $props();

  let filter = $state("");
  let query = $derived(filter.trim().toLowerCase());

  const matches = (session: SessionState) =>
    !query ||
    session.title.toLowerCase().includes(query) ||
    session.cwd.toLowerCase().includes(query) ||
    session.model.toLowerCase().includes(query);

  const visible = $derived(store.list.filter(matches));
  const live = $derived(visible.filter((s) => s.status === "running"));
  const idle = $derived(visible.filter((s) => s.status !== "running" && s.status !== "done"));
  const done = $derived(visible.filter((s) => s.status === "done" || s.status === "error" || s.status === "interrupted"));

  // ---- History: every saved session in the database, not only the ones this server has open.
  // The filter box searches it on the server (title, first message, folder), a moment after typing stops.
  //
  // This effect must depend on `query` and nothing else. It used to read `sidebarHistory.status` to pick
  // the delay; every load changes that status, so the effect re-ran after each answer and asked again:
  // one request every 200 ms, forever. Everything else it touches is read with `untrack`.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let searched = false;
  $effect(() => {
    const q = query;
    const delay = searched ? 200 : 0;
    searched = true;
    clearTimeout(timer);
    timer = setTimeout(() => untrack(() => void sidebarHistory.load(q)), delay);
    return () => clearTimeout(timer);
  });
  // ---- "By folder": every folder with sessions, open and saved ones together, pinned folders first.
  const prefs = $state(loadPrefs());
  $effect(() => savePrefs($state.snapshot(prefs)));
  const home = $derived(store.list.find((s) => s.target === "local" && /^\/home\/[^/]+/.test(s.cwd))?.cwd.match(/^\/home\/[^/]+/)?.[0] ?? "");
  // Loaded on demand: the first time the view is shown, and again when the set of sessions changes.
  $effect(() => {
    if (prefs.view === "folder" && folderStore.status === "idle") untrack(() => void folderStore.load());
  });
  const allSaved = $derived(Object.values(folderStore.items).flat());
  const groups = $derived(
    groupByFolder(
      store.list.filter(matches),
      query ? sidebarHistory.items : allSaved,
      query ? [] : folderStore.folders,
      prefs.pinned,
    ),
  );
  /** While searching every matching folder is open; otherwise what you chose, else open if active or pinned. */
  const isOpen = (g: FolderGroup) => (query ? true : isExpanded(g, prefs));
  function toggleFolder(g: FolderGroup) {
    const next = !isOpen(g);
    prefs.expanded = { ...prefs.expanded, [g.cwd]: next };
    if (next && !folderStore.loaded(g.cwd)) void folderStore.open(g.cwd);
  }
  // Folders that start open load their saved sessions once.
  $effect(() => {
    if (prefs.view !== "folder" || query) return;
    for (const g of groups) if (isOpen(g) && !folderStore.loaded(g.cwd)) untrack(() => void folderStore.open(g.cwd));
  });

  // A session that is open above is not repeated below.
  const saved = $derived(sidebarHistory.items.filter((h) => !store.sessions[h.id]));
  const savedGroups = $derived(groupByRecency(saved));
  // Refresh when the set of open sessions changes (one closed goes back to History, one finished moves).
  // Only the sessions that changed matter: their folders are the only ones the folder view re-reads.
  let lastOpen = new Map<string, string>();
  let started = false;
  $effect(() => {
    const now = new Map(Object.values(store.sessions).map((s) => [s.id, `${s.status}\u0000${s.cwd}`] as const));
    const changed: string[] = [];
    for (const [id, v] of now) if (lastOpen.get(id) !== v) changed.push(v.split("\u0000")[1] ?? "");
    for (const [id, v] of lastOpen) if (!now.has(id)) changed.push(v.split("\u0000")[1] ?? "");
    lastOpen = now;
    if (!started) {
      started = true;
      return;
    }
    if (!changed.length) return;
    // `untrack`: the refreshes read store state that must not become dependencies of this effect.
    untrack(() => {
      void sidebarHistory.refresh();
      if (folderStore.status !== "idle") void folderStore.refresh(changed.map(normalizeCwd));
    });
  });

  // Renaming a window: the row's pencil turns the label into a one-line input.
  let editing = $state("");
  let draft = $state("");
  const startRename = (w: { id: string; name: string | null }) => {
    editing = w.id;
    draft = w.name ?? "";
  };
  const commitRename = () => {
    if (editing) onrename?.(editing, draft);
    editing = "";
  };

  const statusTone = (s: SessionState) =>
    s.status === "running" ? "brand" : s.status === "error" ? "err" : s.status === "done" ? "ok" : "neutral";
</script>

{#snippet sessionRow(session: SessionState)}
          <div
            role="listitem"
            class="group/sess interactive relative cursor-pointer rounded-md py-1.5 pr-2 pl-3 pointer-coarse:py-2.5 pointer-coarse:pr-12
              hover:bg-raised/70"
            class:bg-raised={focusedSession === session.id}
          >
            <button
              class="block w-full cursor-pointer text-left pointer-coarse:min-h-11"
              onclick={() => onopen(session.id)}
              title={session.title}
              aria-current={focusedSession === session.id ? "true" : undefined}
            >
              <div class="flex items-center gap-1.5">
                {#if session.target === "remote"}
                  <Server size={12} class="shrink-0 text-accent" strokeWidth={2} />
                {/if}
                <span class="min-w-0 flex-1 truncate text-[12.5px] leading-4 font-medium text-ink">
                  {session.title || "Untitled"}
                </span>
                {#if paneOf(session.id)}
                  <!-- Which pane shows it: a number, like tmux's pane index. -->
                  <span class="tnum grid h-4 min-w-4 shrink-0 place-items-center rounded-sm bg-overlay px-1 text-[10px] font-semibold text-ink-muted" title="Shown in pane {paneOf(session.id)}">
                    <span aria-hidden="true">{paneOf(session.id)}</span><span class="sr-only">in pane {paneOf(session.id)}</span>
                  </span>
                {:else if inOtherWindow?.(session.id)}
                  <!-- Open, but on another window's screen: where to find it. -->
                  <span class="shrink-0 text-ink-faint" title="On {inOtherWindow(session.id)}"><AppWindow size={12} strokeWidth={1.75} aria-label="On {inOtherWindow(session.id)}" /></span>
                {/if}
                {#if session.status === "running"}
                  <span class="pulse-live size-1.5 shrink-0 rounded-full bg-brand"></span>
                {/if}
              </div>
              <div class="mt-0.5 flex items-center gap-1.5 pl-0 text-[10.5px] leading-4 text-ink-faint">
                <span class="truncate">{baseName(session.cwd)}</span>
                <span>·</span>
                <span class="tnum shrink-0">{relativeTime(session.updatedAt)}</span>
                {#if session.cost > 0}
                  <span>·</span>
                  <span class="tnum shrink-0">{cost(session.cost)}</span>
                {/if}
              </div>
            </button>
            <!-- Per-row actions appear on hover/focus, never hidden from keyboard. -->
            <div class="absolute top-1 right-1 hidden items-center gap-0.5 group-hover/sess:flex group-focus-within/sess:flex pointer-coarse:top-1/2 pointer-coarse:right-0.5 pointer-coarse:flex pointer-coarse:-translate-y-1/2">
              <Button
                variant="ghost"
                size="icon-sm"
                class="pointer-fine:h-6 pointer-fine:w-6"
                icon={Square}
                title={session.status === "running" ? "Interrupt" : "Close session"}
                onclick={() => onclosesession(session.id)}
              />
            </div>
          </div>
{/snippet}

{#snippet savedRow(item: HistoryItem)}
          {@const reason = unresumableReason(item)}
          <div role="listitem" class="interactive relative rounded-md py-1.5 pr-2 pl-3 hover:bg-raised/70 pointer-coarse:py-2.5" data-history={item.id}>
            <button
              type="button"
              class="block w-full cursor-pointer text-left pointer-coarse:min-h-11"
              title={reason ? `${item.title}: read only. ${reason}` : item.title}
              disabled={openingId === item.id}
              onclick={() => onopenhistory(item)}
            >
              <div class="flex items-center gap-1.5">
                <span class="min-w-0 flex-1 truncate text-[12.5px] leading-4 text-ink-muted">{item.title || "Untitled"}</span>
                {#if openingId === item.id}<Spinner size={11} label="Opening" />{/if}
                {#if reason}<span class="shrink-0 text-[10px] text-ink-faint">read only</span>{/if}
              </div>
              <div class="mt-0.5 flex items-center gap-1.5 text-[10.5px] leading-4 text-ink-faint">
                <span class="truncate">{baseName(item.cwd)}</span>
                <span aria-hidden="true">·</span>
                <span class="tnum shrink-0">{relativeTime(item.updatedAt)}</span>
              </div>
            </button>
          </div>
{/snippet}

<aside
  class="flex h-full w-[248px] shrink-0 flex-col border-r border-line/70 bg-canvas pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] max-md:w-[min(20rem,calc(86*var(--vw)))] {klass}"
>
  <!-- Brand / workspace -->
  <div class="flex items-center gap-2 px-3 py-2.5">
    <Terminal size={14} class="shrink-0 text-ink-faint" strokeWidth={1.75} />
    <span class="min-w-0 flex-1 truncate text-[13px] leading-4 font-medium">mini-tui</span>
    <!--
      The connection state is a dot, not a word: it is ambient information and
      never needs a full line of the narrow rail.
    -->
    <span
      class="size-1.5 shrink-0 rounded-full {store.connected ? 'bg-ok' : 'pulse-live bg-warn'}"
      title={store.connected ? "Connected" : "Reconnecting…"}
    ></span>
    <Button variant="ghost" size="icon-sm" icon={PanelLeftClose} title="Hide sidebar" onclick={onhidesidebar} />
  </div>

  <div class="flex gap-1 px-2.5 pb-2">
    <Button variant="subtle" size="sm" icon={Plus} class="min-w-0 flex-1 justify-start" onclick={onnew}>
      New chat
    </Button>
    <Button variant="subtle" size="sm" icon={AppWindowMac} class="pointer-coarse:px-3 shrink-0" title="New window" aria-label="New window" onclick={onnewwindow} />
  </div>

  {#if windows.length}
    <!-- The windows, tmux style: one on screen, the others kept with their panes. -->
    <div class="px-2.5 pb-2" role="group" aria-label="Windows">
      <div class="mb-0.5 flex items-center gap-1.5 px-1">
        <span class="flex items-center gap-1 text-[10px] font-semibold tracking-wider text-ink-faint uppercase"><Layers size={10} strokeWidth={2} aria-hidden="true" />Windows</span>
        <span class="tnum ml-auto text-[10px] text-ink-faint">{windows.length}</span>
      </div>
      <div class="flex flex-col gap-0.5" role="radiogroup" aria-label="Window to show">
        {#each windows as w (w.id)}
          {#if editing === w.id}
            <div class="flex min-h-7 items-center gap-1.5 px-1.5 py-1">
              <AppWindow size={12} strokeWidth={1.75} class="shrink-0 text-brand" aria-hidden="true" />
              <input
                bind:value={draft}
                aria-label="Window name"
                class="h-6 min-w-0 flex-1 rounded-sm border border-brand bg-canvas px-1 text-[12px] text-ink focus:outline-none"
                onkeydown={(e) => {
                  if (e.key === "Enter") commitRename();
                  else if (e.key === "Escape") editing = "";
                }}
                onblur={commitRename}
              />
            </div>
          {:else}
            <div class="group/win flex items-center rounded-md {w.active ? 'bg-raised' : 'hover:bg-raised/70'}">
              <button
                type="button"
                role="radio"
                aria-checked={w.active}
                class="interactive flex min-h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left pointer-coarse:min-h-11
                  {w.active ? 'text-ink' : 'text-ink-muted hover:text-ink'}"
                onclick={() => onwindow?.(w.id)}
              >
                <AppWindow size={12} strokeWidth={1.75} class="shrink-0 {w.active ? 'text-brand' : 'text-ink-faint'}" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate text-[12px] leading-4">{w.label}</span>
                {#if w.active}<span class="pulse-live size-1.5 shrink-0 rounded-full bg-brand" aria-label="on screen"></span>{/if}
                <span class="tnum shrink-0 rounded-sm bg-overlay px-1 text-[10px] font-semibold text-ink-muted" title="{w.panes} {w.panes === 1 ? 'pane' : 'panes'}">{w.panes}</span>
              </button>
              <button
                type="button"
                class="interactive mr-0.5 grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-ink-faint opacity-0 hover:text-ink group-hover/win:opacity-100 group-focus-within/win:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100"
                aria-label="Rename {w.label}"
                title="Rename"
                onclick={() => startRename(w)}
              ><Pencil size={11} strokeWidth={2} aria-hidden="true" /></button>
                <button
                  type="button"
                  class="interactive grid size-6 cursor-pointer place-items-center rounded-sm text-ink-faint pointer-coarse:size-11
                    {w.panes ? 'cursor-not-allowed opacity-40 hover:text-ink-faint' : 'hover:text-ink'}"
                  aria-label="Close {w.label}"
                  aria-disabled={w.panes ? "true" : undefined}
                  title={w.panes ? "Move its panes out first" : "Close this empty window"}
                  onclick={() => !w.panes && onclosewindow?.(w.id)}
                ><X size={12} strokeWidth={2} aria-hidden="true" /></button>
            </div>
          {/if}
        {/each}
      </div>
    </div>
  {/if}

  <!-- Filter -->
  <div class="px-2.5 pb-2">
    <div class="relative">
      <input
        bind:value={filter}
        placeholder="Search sessions…"
        aria-label="Search sessions"
        class="h-9 w-full rounded-md border border-line bg-canvas pr-2 pl-2.5 text-base text-ink placeholder:text-ink-faint pointer-coarse:h-11
          focus:border-brand focus:outline-none"
      />
    </div>
  </div>

  <!-- View: recent (open, then history by day) or by folder. -->
  <div class="px-2.5 pb-1">
    <div class="grid grid-cols-2 gap-0.5 rounded-md bg-raised/60 p-0.5" role="radiogroup" aria-label="Organize sessions">
      {#each [{ id: "recent", label: "Recent", icon: Clock3 }, { id: "folder", label: "By folder", icon: FolderTree }] as v (v.id)}
        {@const Icon = v.icon}
        <button
          type="button"
          role="radio"
          aria-checked={prefs.view === v.id}
          class="interactive flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-sm text-[11.5px] font-medium pointer-coarse:h-11
            {prefs.view === v.id ? 'bg-canvas text-ink elev-1' : 'text-ink-muted hover:text-ink'}"
          onclick={() => (prefs.view = v.id as "recent" | "folder")}
        ><Icon size={12} strokeWidth={2} aria-hidden="true" />{v.label}</button>
      {/each}
    </div>
  </div>

  {#if prefs.view === "folder"}
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3" role="tree" aria-label="Sessions by folder">
      {#if folderStore.status === "loading" && !groups.length}
        <div class="flex flex-col gap-1.5 px-2 pt-2" role="status" aria-label="Loading folders"><Skeleton class="h-8" /><Skeleton class="h-8" /><Skeleton class="h-8" /></div>
      {:else if folderStore.status === "error" && !groups.length}
        <div class="px-2 py-3 text-[11.5px] text-ink-muted" role="alert">
          Could not load folders. <button type="button" class="cursor-pointer font-medium text-ink underline underline-offset-2 pointer-coarse:min-h-11" onclick={() => folderStore.load()}>Retry</button>
        </div>
      {:else if !groups.length}
        <div class="px-2 py-8 text-center text-[12px] text-ink-muted">{query ? `No sessions match “${filter}”` : "No sessions yet"}</div>
      {/if}
      {#each groups as g (g.cwd)}
        {@const t = folderTitle(g.cwd, home)}
        {@const expanded = isOpen(g)}
        <div role="treeitem" aria-expanded={expanded} aria-selected="false" aria-label="{t.name}, {g.total} {g.total === 1 ? 'session' : 'sessions'}" data-folder={g.cwd} class="mt-1">
          <div class="group/folder flex items-center rounded-md hover:bg-raised/70">
            <button
              type="button"
              class="interactive flex min-h-9 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md py-1 pr-1 pl-1.5 text-left pointer-coarse:min-h-11"
              title={g.cwd}
              onclick={() => toggleFolder(g)}
            >
              <ChevronDown size={12} strokeWidth={2.25} class="shrink-0 text-ink-faint transition-[rotate] duration-150 {expanded ? '' : '-rotate-90'}" aria-hidden="true" />
              <Folder size={13} strokeWidth={1.75} class="shrink-0 {g.running ? 'text-brand' : 'text-ink-faint'}" aria-hidden="true" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[12.5px] leading-4 font-medium text-ink">{t.name}</span>
                {#if t.parent}<span class="block truncate font-mono text-[10px] leading-3.5 text-ink-faint">{t.parent}</span>{/if}
              </span>
              {#if g.running}<span class="pulse-live size-1.5 shrink-0 rounded-full bg-brand" aria-label="{g.running} running"></span>{/if}
              <span class="tnum shrink-0 px-1 text-[10.5px] text-ink-faint">{g.total}</span>
            </button>
            <div class="flex shrink-0 items-center opacity-0 group-hover/folder:opacity-100 group-focus-within/folder:opacity-100 pointer-coarse:opacity-100">
              <Button
                variant="ghost"
                size="icon-sm"
                class="pointer-fine:h-6 pointer-fine:w-6"
                icon={FolderPlus}
                title="New chat in {t.name}"
                aria-label="New chat in {g.cwd}"
                onclick={() => onnewin?.(g.cwd, g.open[0]?.target === "remote" ? g.open[0]?.hostId : undefined)}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                class="pointer-fine:h-6 pointer-fine:w-6"
                icon={g.pinned ? PinOff : Pin}
                title={g.pinned ? "Unpin" : "Pin to the top"}
                aria-label={g.pinned ? `Unpin ${g.cwd}` : `Pin ${g.cwd} to the top`}
                aria-pressed={g.pinned}
                onclick={() => (prefs.pinned = toggleIn(prefs.pinned, g.cwd))}
              />
            </div>
          </div>
          {#if expanded}
            <div role="group" class="ml-3 border-l border-line/70 pl-1">
              {#each g.open as session (session.id)}
                {@render sessionRow(session)}
              {/each}
              {#each g.saved as item (item.id)}
                {@render savedRow(item)}
              {/each}
              {#if folderStore.loading[g.cwd] && !g.saved.length && g.total > g.open.length}
                <div class="flex flex-col gap-1 py-1 pl-2" role="status" aria-label="Loading {t.name}"><Skeleton class="h-7" /><Skeleton class="h-7" /></div>
              {:else if !query && folderStore.hasMore(g.cwd, g.total)}
                <button
                  type="button"
                  class="interactive my-0.5 flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 pl-3 text-left text-[11.5px] text-ink-muted hover:bg-raised/70 hover:text-ink pointer-coarse:min-h-11"
                  disabled={folderStore.loading[g.cwd]}
                  onclick={() => folderStore.open(g.cwd, true)}
                >
                  {#if folderStore.loading[g.cwd]}<Spinner size={11} label="" />{/if}Show more ({g.total - g.open.length - g.saved.length} older)
                </button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {:else}
  <!-- Session list -->
  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3" role="list">
    {#each [{ key: "live", label: "Live", items: live }, { key: "idle", label: "Open", items: idle }, { key: "done", label: "Finished", items: done }] as group (group.key)}
      {#if group.items.length}
        <div class="mt-3 mb-1 flex items-center gap-1.5 px-2">
          <span class="text-[10px] font-semibold tracking-wider text-ink-faint uppercase">{group.label}</span>
          <span class="tnum ml-auto text-[10px] text-ink-faint">{group.items.length}</span>
        </div>
        {#each group.items as session (session.id)}
          {@render sessionRow(session)}
        {/each}
      {/if}
    {/each}

    <!-- History: saved sessions from the database, newest first, grouped by day. -->
    {#if saved.length || sidebarHistory.status === "loading" || sidebarHistory.status === "error"}
      <div class="mt-4 mb-1 flex items-center gap-1.5 px-2">
        <span class="text-[10px] font-semibold tracking-wider text-ink-faint uppercase" id="sidebar-history">History</span>
        {#if sidebarHistory.status === "loading" && saved.length}<Spinner size={10} label="Updating history" />{/if}
        <button
          type="button"
          class="interactive ml-auto flex cursor-pointer items-center gap-1 rounded-sm px-1 text-[10.5px] text-ink-faint hover:text-ink pointer-coarse:min-h-11 pointer-coarse:px-2"
          title="Search every saved session, or delete one"
          onclick={onresume}
        ><RotateCcw size={10} strokeWidth={2} aria-hidden="true" />All</button>
      </div>
    {/if}
    {#if sidebarHistory.status === "loading" && !saved.length}
      <div class="flex flex-col gap-1.5 px-2 pt-1" role="status" aria-label="Loading history">
        <Skeleton class="h-8" /><Skeleton class="h-8" /><Skeleton class="h-8" />
      </div>
    {:else if sidebarHistory.status === "error" && !saved.length}
      <div class="px-2 py-2 text-[11.5px] text-ink-muted" role="alert">
        Could not load history. <button type="button" class="cursor-pointer font-medium text-ink underline underline-offset-2 pointer-coarse:min-h-11" onclick={() => sidebarHistory.load(query)}>Retry</button>
      </div>
    {/if}
    {#each savedGroups as group (group.bucket)}
      <div role="group" aria-label="History, {group.bucket}">
        <div class="mt-2 mb-0.5 px-2 text-[10px] text-ink-faint">{group.bucket}</div>
        {#each group.items as item (item.id)}
          {@render savedRow(item)}
        {/each}
      </div>
    {/each}
    {#if sidebarHistory.capped && saved.length}
      <button
        type="button"
        class="interactive mx-2 mt-2 flex w-[calc(100%-1rem)] cursor-pointer items-center justify-center gap-1.5 rounded-md py-1.5 text-[11.5px] text-ink-muted hover:bg-raised/70 hover:text-ink pointer-coarse:min-h-11"
        disabled={sidebarHistory.status === "loading"}
        onclick={() => sidebarHistory.more()}
      >
        {#if sidebarHistory.status === "loading"}<Spinner size={11} label="" />{/if}Show more
      </button>
    {/if}

    {#if loading && !visible.length}
      <div class="flex flex-col gap-2 px-2 pt-3" role="status" aria-label="Loading sessions">
        <Skeleton class="h-9" />
        <Skeleton class="h-9" />
        <Skeleton class="h-9" />
      </div>
    {:else if !visible.length && !saved.length && sidebarHistory.status === "ready"}
      <div class="px-2 py-8 text-center text-[12px] text-ink-muted">
        {query ? `No sessions match “${filter}”` : "No sessions yet"}
      </div>
    {/if}
  </div>

  {/if}

  <!-- Remote hosts -->
  <div class="border-t border-line/80 p-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
    <button
      class="interactive flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left pointer-coarse:min-h-11 pointer-coarse:py-2.5 hover:bg-raised/70"
      onclick={onopenhosts}
    >
      <Server size={14} class="shrink-0 text-ink-muted" strokeWidth={1.75} />
      <div class="min-w-0 flex-1">
        <div class="text-[12.5px] leading-4 font-medium text-ink-muted">Remote hosts</div>
        <div class="tnum text-[10.5px] leading-4 text-ink-faint">
          {store.hosts.filter((h) => h.online).length} online · {store.hosts.length} saved
        </div>
      </div>
      <ChevronRight size={14} class="shrink-0 text-ink-faint" />
    </button>
    <button
      class="interactive flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left pointer-coarse:min-h-11 pointer-coarse:py-2.5 hover:bg-raised/70"
      onclick={onsettings}
    >
      <Settings size={14} class="shrink-0 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
      <span class="text-[12.5px] leading-4 font-medium text-ink-muted">Settings</span>
    </button>
  </div>
</aside>
