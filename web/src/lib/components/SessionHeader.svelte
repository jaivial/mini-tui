<script lang="ts">
  import { Server, Folder, Trash2, PanelLeftOpen, GitBranch, Plus } from "@lucide/svelte";
  import type { Snippet } from "svelte";
  import Button from "./Button.svelte";
  import Badge from "./Badge.svelte";
  import { store } from "../stores/sessions.svelte";
  import { ui, PALETTES } from "../stores/ui.svelte";
  import { cost, duration } from "../format";
  import type { SessionState } from "../types";

  let {
    session,
    onnew,
    ontoggleSidebar,
    onopenhosts,
    onclosesession,
    paneTools,
    showSidebarToggle = true,
  }: {
    /** The pane's own controls (split, notes, close pane), drawn at the end of the action row. */
    paneTools?: Snippet;
    /** Only the first pane shows the sidebar toggle; the others do not repeat it. */
    showSidebarToggle?: boolean;
    session: SessionState;
    onnew: () => void;
    ontoggleSidebar: () => void;
    onopenhosts: () => void;
    /** Stop and drop this session. */
    onclosesession?: () => void;
  } = $props();

  let showPalette = $state(false);
  // Resolve the label from the session's own hostId, not the first host.
  const host = $derived(store.hosts.find((h) => h.id === session.hostId) ?? null);
  const elapsed = $derived(session.status === "running" ? Date.now() - session.startedAt : 0);

  // Escape closes whichever popover is open. Registered on window so it works
  // no matter what has focus, matching how Modal.svelte dismisses itself.
  $effect(() => {
    const on = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (showPalette) showPalette = false;
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });
</script>

<!--
  The palette popover must paint above the transcript. The `.enter-2`
  wrapper in App.svelte is an animated element, and a running/filled animation
  makes it a stacking context, so `z-index` has to be set on the wrapper's
  sibling <main> side too: the header alone cannot outrank it.
-->
<!--
  A three-column grid: toggle | title + meta | actions. On a phone the actions stay
  on the title row and the meta row spans under both, so nothing is squeezed to 0px.
  The text wrapper is `display: contents` so its two rows can be placed independently.
-->
<header
  class="relative z-30 grid min-h-13 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 border-b border-line/80 bg-canvas px-3.5 py-1.5"
>
  {#if showSidebarToggle}
    <Button
      variant="ghost"
      size="icon-sm"
      icon={PanelLeftOpen}
      title="Toggle sidebar"
      class="row-span-2 pane-sm:row-span-1"
      onclick={ontoggleSidebar}
    />
  {:else}
    <span class="w-0"></span>
  {/if}

  <div class="contents">
    <div class="col-start-2 flex min-w-0 items-center gap-2 self-end pane-sm:self-center">
      <h1 class="truncate text-[13.5px] leading-4 font-semibold">{session.title || "Untitled"}</h1>
      <!--
        One status dot, not a badge: the shape and the colour both carry the
        state, and the running one breathes. Motion is never the only channel.
      -->
      {#if session.status === "running"}
        <span class="flex shrink-0 items-center gap-1.5 text-[11.5px] text-ink-muted">
          <span class="pulse-live size-1.5 rounded-full bg-brand"></span>
          running
        </span>
      {:else if session.status === "error"}
        <span class="flex shrink-0 items-center gap-1.5 text-[11.5px] text-err">
          <span class="size-1.5 rounded-full bg-err"></span>
          error
        </span>
      {:else if session.status === "done"}
        <span class="flex shrink-0 items-center gap-1.5 text-[11.5px] text-ink-faint">
          <span class="size-1.5 rounded-full bg-ok"></span>
          {session.exitStatus || "done"}
        </span>
      {/if}
      {#if session.target === "remote"}
        <Badge tone="neutral">
          <Server size={10} strokeWidth={2.25} /> {host?.label ?? "remote"}
        </Badge>
      {/if}
    </div>
    <div class="col-start-2 row-start-2 mt-px flex min-w-0 items-center gap-2 self-start text-[11px] text-ink-faint pane-sm:col-span-2 pane-sm:mt-0.5 pane-sm:pb-0.5">
      <span class="flex min-w-0 items-center gap-1 pane-sm:hidden">
        <Folder size={11} strokeWidth={1.75} class="shrink-0" />
        <span class="truncate font-mono">{session.cwd}</span>
      </span>
      {#if session.apiCalls}
        <span class="tnum shrink-0 whitespace-nowrap">{session.apiCalls} {session.apiCalls === 1 ? "call" : "calls"}</span>
      {/if}
      {#if session.cost > 0}
        <span class="tnum shrink-0 whitespace-nowrap">{cost(session.cost)}</span>
      {/if}
      {#if elapsed > 0}
        <span class="tnum shrink-0 whitespace-nowrap">{duration(elapsed)}</span>
      {/if}
    </div>
  </div>

  <!-- Actions: one cell so the grid can keep them on the title row. -->
  <div class="col-start-3 row-span-2 flex items-center gap-1 pane-sm:row-span-1">
  <!-- Theme palette switcher: a swatch popover, live-repainting. Settings has the same choice, so a
       very narrow pane drops this shortcut rather than push the pane's own controls off-screen. -->
  <div class="relative pane-xs:hidden">
    <button
      class="interactive flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-raised pointer-coarse:size-11"
      title="Color palette"
      onclick={() => (showPalette = !showPalette)}
      aria-haspopup="menu"
      aria-expanded={showPalette}
    >
      <span class="size-2.5 rounded-full ring-1 ring-line ring-inset" style="background: var(--color-accent)"></span>
    </button>
    {#if showPalette}
      <div
        class="elev-pop enter-pop absolute right-0 z-40 mt-1.5 w-44 rounded-lg p-1 pane-sm:fixed pane-sm:top-auto pane-sm:right-3 pane-sm:mt-1"
        role="menu"
      >
        {#each PALETTES as p (p.id)}
          <button
            class="interactive flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-raised pointer-coarse:py-2.5"
            role="menuitem"
            onclick={() => {
              ui.setPalette(p.id);
              showPalette = false;
            }}
          >
            <span class="size-3.5 shrink-0 rounded-full" style="background: {p.swatch}"></span>
            <span class="flex-1 text-[12.5px] {ui.palette === p.id ? 'font-semibold text-ink' : 'text-ink-muted'}">{p.name}</span>
            {#if ui.palette === p.id}<GitBranch size={12} class="text-brand" strokeWidth={2.5} />{/if}
          </button>
        {/each}
        <div class="my-1 h-px bg-line"></div>
        <button
          class="interactive flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-raised pointer-coarse:py-2.5"
          role="menuitem"
          onclick={() => {
            ui.toggleTheme();
            showPalette = false;
          }}
        >
          <span class="flex-1 text-[12.5px] text-ink-muted">{ui.theme === "dark" ? "Light" : "Dark"} mode</span>
        </button>
      </div>
    {/if}
  </div>

  <Button variant="ghost" size="icon-sm" icon={Trash2} title="Close session" class="pane-xs:hidden" onclick={onclosesession} />
  <Button variant="secondary" size="sm" icon={Plus} class="pane-sm:min-w-11" onclick={onnew} aria-label="New chat here" title="New chat in this pane">
    <span class="pane-sm:sr-only">New</span>
  </Button>
  {#if paneTools}{@render paneTools()}{/if}
  </div>
</header>
