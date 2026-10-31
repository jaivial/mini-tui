<script lang="ts">
  import { untrack } from "svelte";
  import { ChevronRight, Folder, FolderPlus, MoreHorizontal, Pencil, Plus, Server, SquarePen, Trash2, X } from "@lucide/svelte";
  import Button from "./Button.svelte";
  import Age from "./Age.svelte";
  import { store } from "../stores/sessions.svelte";
  import { workspaces } from "../stores/workspaces.svelte";
  import { toasts } from "../stores/toast.svelte";
  import { tildify } from "../folderPath";
  import { groupWorkspaces, type RowState } from "../savedWorkspaces";

  /**
   * Manual chat mode's sidebar: one section per saved workspace, each with its sessions (live ones
   * from the server, saved ones from the history of its folder) and a button to start a new one.
   */
  let {
    activeId,
    activeWorkspaceId,
    draft,
    exclude = [],
    onopen,
    onnew,
    onadd,
    onclose,
  }: {
    /** The session on screen ("" while a new-session draft is). */
    activeId: string;
    activeWorkspaceId: string;
    /** A new-session draft is on screen (in `activeWorkspaceId`). */
    draft: boolean;
    /** Sessions never listed here (the dispatcher's chat and its workers). */
    exclude?: string[];
    onopen: (sessionId: string, workspaceId: string) => void;
    onnew: (workspaceId: string) => void;
    onadd: () => void;
    onclose?: () => void;
  } = $props();

  const COLLAPSED_KEY = "minitui.manual.collapsed";
  function loadCollapsed(): Record<string, boolean> {
    try {
      const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}");
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }
  let collapsed = $state<Record<string, boolean>>(loadCollapsed());
  function toggle(id: string) {
    collapsed[id] = !collapsed[id];
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed));
    } catch {
      /* private mode */
    }
  }

  const live = $derived(Object.values(store.sessions));
  const groups = $derived(groupWorkspaces(workspaces.list, live, workspaces.saved, exclude));
  const total = $derived(groups.reduce((n, g) => n + g.rows.length, 0));

  // Saved sessions are re-read when the set of live sessions (or of workspaces) changes: one started,
  // finished or was closed. Never on a timer.
  const signature = $derived(
    workspaces.list.map((w) => `${w.id}:${w.path}`).join("|") + "#" + live.filter((s) => !s.role && !s.parentId).map((s) => `${s.id}:${s.status}`).sort().join(","),
  );
  $effect(() => {
    signature;
    const timer = setTimeout(() => untrack(() => void workspaces.refreshSaved()), 300);
    return () => clearTimeout(timer);
  });

  const hostLabel = (id?: string) => (id ? (store.hosts.find((h) => h.id === id)?.label ?? id) : "");
  const dot = (state: RowState) => (state === "working" ? "pulse-live bg-live" : state === "done" ? "bg-ok" : state === "error" ? "bg-err" : "bg-line-strong");

  // ---- the per-workspace menu: rename, remove
  let menuFor = $state("");
  let confirming = $state("");
  let renaming = $state("");
  let renameValue = $state("");
  function openMenu(id: string) {
    menuFor = menuFor === id ? "" : id;
    confirming = "";
  }
  function startRename(id: string, name: string) {
    menuFor = "";
    renaming = id;
    renameValue = name;
  }
  async function commitRename() {
    const id = renaming;
    const value = renameValue.trim();
    renaming = "";
    if (!id || !value || value === workspaces.byId(id)?.name) return;
    try {
      await workspaces.rename(id, value);
    } catch (error) {
      toasts.push("Could not rename the workspace", { detail: (error as Error).message, tone: "err" });
    }
  }
  async function remove(id: string) {
    menuFor = "";
    confirming = "";
    try {
      await workspaces.remove(id);
    } catch (error) {
      toasts.push("Could not remove the workspace", { detail: (error as Error).message, tone: "err" });
    }
  }
  $effect(() => {
    if (!menuFor) return;
    const id = menuFor;
    const away = (event: PointerEvent) => {
      if (!(event.target as HTMLElement)?.closest?.(`[data-menu="${id}"]`)) menuFor = "";
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  });
  const focusOnMount = (node: HTMLInputElement) => {
    node.focus();
    node.select();
  };
</script>

<aside class="manual-sidebar flex h-full min-h-0 w-full flex-col border-r border-line/80 bg-surface" aria-label="Workspaces and sessions">
  <header class="flex min-h-16 shrink-0 items-center gap-2.5 border-b border-line/80 px-4">
    <span class="grid size-8 shrink-0 place-items-center rounded-[10px] border border-brand/25 bg-brand-soft text-brand-fg">
      <Folder size={15} strokeWidth={1.9} aria-hidden="true" />
    </span>
    <div class="min-w-0 flex-1">
      <h2 class="font-display text-[13px] font-semibold tracking-[-0.01em] text-ink">Workspaces</h2>
      <p class="mt-0.5 truncate text-[10px] text-ink-faint">{groups.length} workspace{groups.length === 1 ? "" : "s"} · {total} session{total === 1 ? "" : "s"}</p>
    </div>
    <Button variant="ghost" size="icon-sm" icon={FolderPlus} aria-label="New workspace" title="New workspace" onclick={onadd} />
    {#if onclose}<Button variant="ghost" size="icon-sm" icon={X} aria-label="Hide workspaces" title="Hide workspaces" onclick={onclose} />{/if}
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
    {#if workspaces.status === "loading" && !groups.length}
      <p class="px-3 py-4 text-[11px] text-ink-faint" role="status">Loading workspaces…</p>
    {:else if !groups.length}
      <div class="mx-2 mt-5 rounded-xl border border-dashed border-line-strong/70 px-4 py-6 text-center">
        <Folder size={18} class="mx-auto mb-2 text-ink-faint" aria-hidden="true" />
        <p class="text-[11.5px] font-medium text-ink-muted">Add a workspace to start</p>
        <p class="mt-1.5 mb-3 text-[10px] leading-4 text-ink-faint">A workspace is a folder, on this machine or a remote host. Its sessions run there and are listed under it.</p>
        <Button variant="outline" size="sm" icon={FolderPlus} onclick={onadd}>New workspace</Button>
      </div>
    {:else}
      <div class="flex flex-col gap-1.5">
        {#each groups as group (group.workspace.id)}
          {@const ws = group.workspace}
          {@const open = !collapsed[ws.id]}
          {@const drafting = draft && activeWorkspaceId === ws.id}
          <section class="relative" aria-label={ws.name} data-workspace={ws.id}>
            <div class="flex min-h-11 items-center gap-0.5 rounded-lg pr-1 hover:bg-raised/50 {activeWorkspaceId === ws.id ? 'bg-raised/30' : ''}">
              {#if renaming === ws.id}
                <input
                  use:focusOnMount
                  bind:value={renameValue}
                  aria-label="Workspace name"
                  maxlength="80"
                  class="ml-1.5 h-8 min-w-0 flex-1 rounded-md border border-brand bg-canvas px-2 text-[12px] text-ink outline-none"
                  onkeydown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitRename();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      renaming = "";
                    }
                  }}
                  onblur={() => void commitRename()}
                />
              {:else}
                <button
                  type="button"
                  class="interactive flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-ink-muted hover:text-ink"
                  aria-expanded={open}
                  title={ws.hostId ? `${ws.path} on ${hostLabel(ws.hostId)}` : ws.path}
                  onclick={() => toggle(ws.id)}
                >
                  <ChevronRight size={11} class="shrink-0 transition-transform {open ? 'rotate-90' : ''}" aria-hidden="true" />
                  <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-1.5">
                      <span class="truncate text-[11.5px] font-semibold text-ink">{ws.name}</span>
                      {#if ws.hostId}
                        <span class="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-raised px-1 py-0.5 text-[9px] font-medium text-ink-muted" title="Runs on {hostLabel(ws.hostId)}"><Server size={9} aria-hidden="true" />{hostLabel(ws.hostId)}</span>
                      {/if}
                    </span>
                    <span class="mt-0.5 block truncate font-mono text-[9.5px] text-ink-faint">{tildify(ws.path, ws.hostId ? "" : workspaces.home)}</span>
                  </span>
                  {#if group.running}<span class="flex items-center gap-1 text-[9px] text-live" aria-label="{group.running} working"><span class="pulse-live size-1 rounded-full bg-live"></span>{group.running}</span>{/if}
                </button>
              {/if}
              <Button variant="ghost" size="icon-sm" icon={Plus} aria-label="New session in {ws.name}" title="New session in {ws.name}" onclick={() => onnew(ws.id)} />
              <span data-menu={ws.id} class="contents">
                <Button variant="ghost" size="icon-sm" icon={MoreHorizontal} aria-label="Options for {ws.name}" title="Workspace options" aria-haspopup="menu" aria-expanded={menuFor === ws.id} active={menuFor === ws.id} onclick={() => openMenu(ws.id)} />
              </span>
            </div>
            {#if menuFor === ws.id}
              <div class="flex justify-end px-1.5 pb-1.5">
                <div data-menu={ws.id} role="menu" aria-label="Options for {ws.name}" class="elev-pop enter-pop flex w-56 flex-col gap-0.5 rounded-lg p-1">
                  {#if confirming === ws.id}
                    <p class="px-2 pt-1.5 text-[11.5px] text-ink">Remove “{ws.name}”?</p>
                    <p class="px-2 py-1.5 text-[10.5px] leading-4 text-ink-muted">Its sessions are kept; only the workspace leaves the sidebar.</p>
                    <div class="flex justify-end gap-1 p-1">
                      <Button variant="ghost" size="xs" onclick={() => (confirming = "")}>Cancel</Button>
                      <Button variant="danger" size="xs" onclick={() => void remove(ws.id)}>Remove</Button>
                    </div>
                  {:else}
                    <button type="button" role="menuitem" class="interactive flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[12px] text-ink hover:bg-raised pointer-coarse:min-h-11" onclick={() => startRename(ws.id, ws.name)}>
                      <Pencil size={12} aria-hidden="true" />Rename
                    </button>
                    <button type="button" role="menuitem" class="interactive flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[12px] text-err hover:bg-err/10 pointer-coarse:min-h-11" onclick={() => (confirming = ws.id)}>
                      <Trash2 size={12} aria-hidden="true" />Remove workspace
                    </button>
                  {/if}
                </div>
              </div>
            {/if}
            {#if open}
              <ul class="mt-0.5 flex flex-col gap-0.5 pl-3" aria-label="Sessions in {ws.name}">
                {#if drafting}
                  <li>
                    <div class="flex min-h-11 w-full items-center gap-2 rounded-lg border border-brand/30 bg-brand-soft px-2.5 py-1.5" aria-current="page">
                      <SquarePen size={11} class="shrink-0 text-brand-fg" aria-hidden="true" />
                      <span class="min-w-0 flex-1 truncate text-[11px] font-medium text-ink">New session</span>
                    </div>
                  </li>
                {/if}
                {#each group.rows as row (row.id)}
                  <li>
                    <button
                      type="button"
                      class="interactive flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors
                        {activeId === row.id ? 'border-brand/30 bg-brand-soft' : 'border-transparent hover:bg-raised/45'}"
                      aria-current={activeId === row.id ? "page" : undefined}
                      onclick={() => onopen(row.id, ws.id)}
                    >
                      <span class="size-1.5 shrink-0 rounded-full {dot(row.state)}" aria-hidden="true"></span>
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-[11px] font-medium text-ink">{row.title}</span>
                        <span class="mt-0.5 block truncate text-[9px] text-ink-faint">{row.state} · <Age at={row.updatedAt} /></span>
                      </span>
                    </button>
                  </li>
                {:else}
                  {#if !drafting}
                    <li>
                      <button type="button" class="interactive flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left text-[10.5px] text-ink-faint hover:bg-raised/45 hover:text-ink" onclick={() => onnew(ws.id)}>
                        <Plus size={11} aria-hidden="true" />No sessions yet. Start one
                      </button>
                    </li>
                  {/if}
                {/each}
              </ul>
            {/if}
          </section>
        {/each}
      </div>
    {/if}
  </div>
</aside>

<style>
  .manual-sidebar {
    background-image: linear-gradient(180deg, color-mix(in oklab, var(--color-brand) 2%, transparent), transparent 12rem);
    scrollbar-width: thin;
    scrollbar-color: var(--color-line-strong) transparent;
  }
</style>
