<script lang="ts">
  import { Bot, ChevronRight, Folder, MessageSquare, X } from "@lucide/svelte";
  import Button from "./Button.svelte";
  import type { QueueTask } from "../types";

  /** Worker sessions grouped by the workspace names the dispatcher assigns. */
  let {
    tasks,
    mainId,
    activeId,
    onmain,
    onopen,
    onclose,
  }: {
    tasks: QueueTask[];
    mainId: string;
    activeId: string;
    onmain: () => void;
    onopen: (sessionId: string) => void;
    onclose?: () => void;
  } = $props();

  let collapsed = $state<Record<string, boolean>>({});
  const groups = $derived.by(() => {
    const byName = new Map<string, QueueTask[]>();
    for (const task of tasks) {
      if (!task.sessionId) continue;
      const name = task.workspace || "General";
      const group = byName.get(name) ?? [];
      group.push(task);
      byName.set(name, group);
    }
    return [...byName.entries()]
      .map(([name, sessions]) => ({
        name,
        sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
        running: sessions.filter((task) => task.status === "running").length,
        updatedAt: Math.max(...sessions.map((task) => task.updatedAt)),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });
</script>

<aside class="workspace-sidebar flex h-full min-h-0 w-full flex-col border-r border-line/80 bg-surface" aria-label="Workspaces and sessions">
  <header class="flex min-h-16 shrink-0 items-center gap-2.5 border-b border-line/80 px-4">
    <span class="grid size-8 shrink-0 place-items-center rounded-[10px] border border-brand/25 bg-brand-soft text-brand-fg">
      <Folder size={15} strokeWidth={1.9} aria-hidden="true" />
    </span>
    <div class="min-w-0 flex-1">
      <h2 class="font-display text-[13px] font-semibold tracking-[-0.01em] text-ink">Workspaces</h2>
      <p class="mt-0.5 text-[10px] text-ink-faint">{groups.length} groups · {groups.reduce((n, group) => n + group.sessions.length, 0)} sessions</p>
    </div>
    {#if onclose}<Button variant="ghost" size="icon-sm" icon={X} aria-label="Hide workspaces" title="Hide workspaces" onclick={onclose} />{/if}
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
    <button
      type="button"
      class="interactive mb-2 flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-[10px] border px-3 text-left transition-colors
        {mainId && activeId === mainId ? 'border-brand/35 bg-brand-soft text-ink' : 'border-transparent text-ink-muted hover:bg-raised/55 hover:text-ink'}"
      aria-current={mainId && activeId === mainId ? "page" : undefined}
      onclick={onmain}
    >
      <MessageSquare size={14} class="shrink-0 text-brand-fg" aria-hidden="true" />
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[11.5px] font-medium">Main conversation</span>
        <span class="mt-0.5 block text-[9.5px] text-ink-faint">{mainId ? "Dispatcher" : "Starts with your first message"}</span>
      </span>
    </button>

    {#if !groups.length}
      <div class="mx-2 mt-5 rounded-xl border border-dashed border-line-strong/70 px-4 py-6 text-center">
        <Bot size={18} class="mx-auto mb-2 text-ink-faint" aria-hidden="true" />
        <p class="text-[11px] font-medium text-ink-muted">No worker sessions yet</p>
        <p class="mt-1.5 text-[10px] leading-4 text-ink-faint">The dispatcher will create and group them by workspace as tasks arrive.</p>
      </div>
    {:else}
      <div class="flex flex-col gap-1">
        {#each groups as group (group.name)}
          <section class="rounded-[10px] border border-transparent" aria-label={group.name}>
            <button
              type="button"
              class="interactive flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left text-ink-muted hover:bg-raised/50 hover:text-ink"
              aria-expanded={collapsed[group.name] !== true}
              onclick={() => (collapsed[group.name] = collapsed[group.name] !== true)}
            >
              <ChevronRight size={11} class="shrink-0 transition-transform {collapsed[group.name] === true ? '' : 'rotate-90'}" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate text-[10px] font-semibold tracking-[0.04em] uppercase">{group.name}</span>
              {#if group.running}<span class="flex items-center gap-1 text-[9px] text-live"><span class="pulse-live size-1 rounded-full bg-live"></span>{group.running}</span>{/if}
              <span class="tnum text-[9px] text-ink-faint">{group.sessions.length}</span>
            </button>
            {#if collapsed[group.name] !== true}
              <ul class="mt-0.5 flex flex-col gap-0.5 pl-3">
                {#each group.sessions as task (task.id)}
                  <li>
                    <button
                      type="button"
                      class="interactive flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors
                        {activeId === task.sessionId ? 'border-brand/30 bg-brand-soft' : 'border-transparent hover:bg-raised/45'}"
                      aria-current={activeId === task.sessionId ? "page" : undefined}
                      onclick={() => onopen(task.sessionId)}
                    >
                      <span class="size-1.5 shrink-0 rounded-full {task.status === 'running' ? 'pulse-live bg-live' : task.status === 'done' ? 'bg-ok' : task.status === 'error' ? 'bg-err' : 'bg-line-strong'}" aria-hidden="true"></span>
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-[11px] font-medium text-ink">{task.title}</span>
                        <span class="mt-0.5 block truncate font-mono text-[9px] text-ink-faint">{task.id} · {task.status}</span>
                      </span>
                    </button>
                  </li>
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
  .workspace-sidebar {
    background-image: linear-gradient(180deg, color-mix(in oklab, var(--color-brand) 2%, transparent), transparent 12rem);
    scrollbar-width: thin;
    scrollbar-color: var(--color-line-strong) transparent;
  }
</style>
