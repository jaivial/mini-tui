<script lang="ts">
  import { Plus, Server, Terminal, ChevronRight, Square, PanelLeftClose, Settings } from "@lucide/svelte";
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

  const statusTone = (s: SessionState) =>
    s.status === "running" ? "brand" : s.status === "error" ? "err" : s.status === "done" ? "ok" : "neutral";
</script>

<aside
  class="flex h-full w-[248px] shrink-0 flex-col border-r border-line/70 bg-canvas pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] max-md:w-[min(20rem,86vw)] {klass}"
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

  <div class="px-2.5 pb-2">
    <Button variant="subtle" size="sm" icon={Plus} class="w-full justify-start" onclick={onnew}>
      New chat
    </Button>
  </div>

  <!-- Filter -->
  <div class="px-2.5 pb-2">
    <div class="relative">
      <input
        bind:value={filter}
        placeholder="Filter sessions…"
        aria-label="Filter sessions"
        class="h-9 w-full rounded-md border border-line bg-canvas pr-2 pl-2.5 text-base text-ink placeholder:text-ink-faint pointer-coarse:h-11
          focus:border-brand focus:outline-none"
      />
    </div>
  </div>

  <!-- Session list -->
  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3" role="list">
    {#each [{ key: "live", label: "Live", items: live }, { key: "idle", label: "Open", items: idle }, { key: "done", label: "History", items: done }] as group (group.key)}
      {#if group.items.length}
        <div class="mt-3 mb-1 flex items-center gap-1.5 px-2">
          <span class="text-[10px] font-semibold tracking-wider text-ink-faint uppercase">{group.label}</span>
          <span class="tnum ml-auto text-[10px] text-ink-faint">{group.items.length}</span>
        </div>
        {#each group.items as session (session.id)}
          <div
            role="listitem"
            class="group/sess interactive relative cursor-pointer rounded-md py-1.5 pr-2 pl-3 pointer-coarse:py-2.5 pointer-coarse:pr-12
              hover:bg-raised/70"
            class:bg-raised={store.activeId === session.id}
          >
            <button
              class="block w-full cursor-pointer text-left"
              onclick={() => store.setActive(session.id)}
              title={session.title}
            >
              <div class="flex items-center gap-1.5">
                {#if session.target === "remote"}
                  <Server size={12} class="shrink-0 text-accent" strokeWidth={2} />
                {/if}
                <span class="min-w-0 flex-1 truncate text-[12.5px] leading-4 font-medium text-ink">
                  {session.title || "Untitled"}
                </span>
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
        {/each}
      {/if}
    {/each}

    {#if loading && !visible.length}
      <div class="flex flex-col gap-2 px-2 pt-3" role="status" aria-label="Loading sessions">
        <Skeleton class="h-9" />
        <Skeleton class="h-9" />
        <Skeleton class="h-9" />
      </div>
    {:else if !visible.length}
      <div class="px-2 py-8 text-center text-[12px] text-ink-muted">
        {query ? `No sessions match “${filter}”` : "No sessions yet"}
      </div>
    {/if}
  </div>

  <!-- Remote hosts -->
  <div class="border-t border-line/80 p-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
    <button
      class="interactive flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left pointer-coarse:py-2.5 hover:bg-raised/70"
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
      class="interactive flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left pointer-coarse:py-2.5 hover:bg-raised/70"
      onclick={onsettings}
    >
      <Settings size={14} class="shrink-0 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
      <span class="text-[12.5px] leading-4 font-medium text-ink-muted">Settings</span>
    </button>
  </div>
</aside>
