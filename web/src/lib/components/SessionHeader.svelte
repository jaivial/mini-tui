<script lang="ts">
  import { Server, PanelLeftOpen } from "@lucide/svelte";
  import type { Snippet } from "svelte";
  import Button from "./Button.svelte";
  import Badge from "./Badge.svelte";
  import Avatar from "./Avatar.svelte";
  import HeaderMenu, { type MenuRow } from "./HeaderMenu.svelte";
  import { store } from "../stores/sessions.svelte";
  import { duration } from "../format";
  import type { SessionState } from "../types";

  /**
   * The pane's header: who you are talking to, what it is doing, and — from v6 — ONE three-dots
   * button holding every action the header used to spread across six icon buttons and two menus.
   *
   * The identity half (avatar, title, state in words, cwd, elapsed) stays exactly
   * where it was: it is the thing you read, not a control. The calls/cost strip that used to sit
   * under the header is gone (v6-G): the numbers were noise on a phone and the same data is on the
   * usage panel. Everything you DO moved into `HeaderMenu`, which draws one popover through a
   * portal. `rows` is built by ChatPane, so a brand-new chat and a live one offer different sets
   * without a second popover.
   */
  let {
    session,
    ontoggleSidebar,
    rows = [],
    paneTools,
    showSidebarToggle = true,
  }: {
    session: SessionState;
    ontoggleSidebar: () => void;
    /** Every action for this pane, in order. The header only draws them. */
    rows?: MenuRow[];
    /** The pane's drag grip: a pointer target, so it stays in the header rather than the menu. */
    paneTools?: Snippet;
    /** Only the first pane shows the sidebar toggle; the others do not repeat it. */
    showSidebarToggle?: boolean;
  } = $props();

  // Resolve the label from the session's own hostId, not the first host.
  const host = $derived(store.hosts.find((h) => h.id === session.hostId) ?? null);
  const elapsed = $derived(session.status === "running" ? Date.now() - session.startedAt : 0);
</script>

<!--
  The popover must paint above the transcript. The `.enter-2` wrapper in App.svelte is an animated
  element, and a running/filled animation makes it a stacking context, so `z-index` has to be set
  on the wrapper's sibling <main> side too: the header alone cannot outrank it.
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
      title="Toggle bots list"
      aria-label="Toggle bots list"
      class="row-span-2 pane-sm:row-span-1"
      onclick={ontoggleSidebar}
    />
  {:else}
    <span class="w-0"></span>
  {/if}

  <div class="contents">
    <div class="col-start-2 flex min-w-0 items-center gap-2.5 self-end pane-sm:self-center">
      <Avatar id={session.id} size={32} />
      <h1 class="truncate font-display text-[14px] leading-4 font-semibold tracking-[-0.01em]">{session.title || "Untitled"}</h1>
      <!--
        One status dot, not a badge: the shape and the colour both carry the
        state, and the running one breathes. Motion is never the only channel.
      -->
      {#if session.status === "running"}
        <span class="flex shrink-0 items-center gap-1.5 text-[11.5px] text-live">
          <span class="pulse-live size-1.5 rounded-full bg-live"></span>
          working
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
      {#if elapsed > 0}
        <span class="tnum shrink-0 whitespace-nowrap">{duration(elapsed)}</span>
      {/if}
    </div>
  </div>

  <!-- Every action, one button: new chat here, the panels, the pane's own tools, the app's modals. -->
  <div class="col-start-3 row-span-2 flex items-center gap-1 pane-sm:row-span-1">
    {#if paneTools}{@render paneTools()}{/if}
    <HeaderMenu label="Bot menu" {rows} />
  </div>
</header>