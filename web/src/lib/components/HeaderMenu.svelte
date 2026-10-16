<script lang="ts">
  import type { Component } from "svelte";
  import { MoreHorizontal, Moon, Sun } from "@lucide/svelte";
  import Popover from "./Popover.svelte";
  import { ui, PALETTES } from "../stores/ui.svelte";

  /**
   * The header's whole action set behind ONE three-dots button (Jaime's v6 spec).
   *
   * Before this, the actions were scattered across the pane header (palette, close session, new
   * chat), the sidebar footer (Routines, Team map, hosts, settings, resume) and the pane menu.
   * They now live in one popover, anchored to the button and drawn through `Popover.svelte` (a
   * portal), so it is never clipped by the pane it hangs off and stays put while the rail scrolls.
   *
   * The rows are handed in rather than hard-wired here, so the caller (ChatPane) owns which actions
   * exist for that pane — a brand-new chat offers far fewer than a live one. That keeps one popover
   * and one dismiss handler for the whole header instead of a menu inside a menu. A row whose
   * `group` differs from the one above it starts a new section.
   *
   * v6-G polish: the card is one width on every screen and can never outgrow the viewport (the
   * 1033px-in-an-844px-window regression must not come back); every row keeps a fixed icon slot so
   * the labels line up whether or not a row has an icon; sections are separated by a rule instead of
   * whitespace alone; and the focus ring is drawn INSIDE the row (`-outline-offset-2`) because the
   * card scrolls and an outward ring would be clipped at its edges.
   */
  export interface MenuRow {
    id: string;
    label: string;
    /** Shown under the label in a muted colour: a shortcut, a count, or why it cannot run. */
    note?: string;
    icon?: Component<any>;
    group?: string;
    /** A row that cannot run says why in `note` instead of disappearing. */
    disabled?: boolean;
    danger?: boolean;
    run: () => void;
  }

  let {
    label = "Menu",
    rows = [],
  }: {
    label?: string;
    /** The rows, in order. A changed `group` starts a new section. */
    rows?: MenuRow[];
  } = $props();

  const uid = $props.id();
  let button = $state<HTMLElement | null>(null);
  let open = $state(false);

  function pick(row: MenuRow) {
    if (row.disabled) return;
    open = false;
    row.run();
  }

  /** A row starts a new section when its group differs from the one above it. */
  const newGroup = (i: number) => !!rows[i]?.group && rows[i - 1]?.group !== rows[i]?.group;

  /**
   * Arrow keys walk the rows, Home/End jump. Escape and outside presses are Popover's job.
   *
   * The card is a portal under `document.body`, so the rows are found through the popover family
   * name (`data-popover`, set from the `family` handed to `Popover`) rather than by walking up the
   * DOM from the trigger — the trigger's ancestors do not contain the card.
   */
  function onkeydown(event: KeyboardEvent) {
    const card = document.querySelector(`[data-popover="${uid}"]`);
    if (!card) return;
    const all = [...card.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')];
    if (!all.length) return;
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      all[(i + (event.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      all[event.key === "Home" ? 0 : all.length - 1]?.focus();
    }
  }
</script>

<div class="relative">
  <button
    bind:this={button}
    type="button"
    class="interactive grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-ink-muted hover:bg-raised hover:text-ink pointer-coarse:size-11"
    title={label}
    aria-label={label}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls="{uid}-menu"
    data-active={open || undefined}
    onclick={() => (open = !open)}
  >
    <MoreHorizontal size={16} strokeWidth={2} aria-hidden="true" />
  </button>
</div>

<!--
  `onkeydown` is bound on the wrapper so it reaches the portalled card: the listener wraps the rows,
  which live in the card, and the card is a child of `document.body`, not of this component.
-->
<Popover
  open={open}
  anchor={() => button}
  placement="bottom"
  role="menu"
  label={label}
  width="w-64 max-w-[calc(100vw-1rem)]"
  family={uid}
  onclose={() => (open = false)}
>
  <div
    class="flex max-h-[min(58vh,26rem)] flex-col overflow-y-auto overscroll-contain"
    onkeydown={onkeydown}
    role="presentation"
  >
    {#each rows as row, i (row.id)}
      {#if newGroup(i)}
        <!-- A rule, not just a gap: six groups of three rows is a wall of text without one. -->
        <div class="mt-1.5 mb-1 flex items-center gap-2 px-2.5 pt-1.5 first:mt-0 first:pt-0">
          <span class="text-[10px] font-semibold tracking-wider text-ink-faint uppercase">{row.group}</span>
          <span class="h-px min-w-0 flex-1 bg-line/70" aria-hidden="true"></span>
        </div>
      {/if}
      <button
        type="button"
        role="menuitem"
        id="{uid}-row-{row.id}"
        aria-disabled={row.disabled ? "true" : undefined}
        class="interactive flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left hover:bg-raised focus-visible:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand pointer-coarse:min-h-11
          {row.disabled ? 'cursor-not-allowed text-ink-faint' : row.danger ? 'text-err' : 'text-ink'}"
        onclick={() => pick(row)}
      >
        <!-- A fixed slot, so labels line up across a section whether or not that row has an icon. -->
        <span class="grid size-4 shrink-0 place-items-center" aria-hidden="true">
          {#if row.icon}
            {@const Icon = row.icon}
            <Icon size={15} strokeWidth={1.75} class="opacity-70" />
          {/if}
        </span>
        <span class="min-w-0 flex-1 py-1.5">
          <span class="block truncate text-[13px] leading-5">{row.label}</span>
          {#if row.note}<span class="block truncate text-[11px] leading-4 text-ink-faint">{row.note}</span>{/if}
        </span>
      </button>
    {/each}
  </div>

  <!-- The palette, where it has always lived: six swatches plus the light/dark flip. -->
  <div class="mt-2 border-t border-line/80 px-2.5 pt-2 pb-0.5">
    <div class="mb-1.5 text-[10px] font-semibold tracking-wider text-ink-faint uppercase">Colour</div>
    <div class="flex flex-wrap items-center gap-1">
      {#each PALETTES as p (p.id)}
        <button
          type="button"
          class="interactive grid size-8 shrink-0 cursor-pointer place-items-center rounded-full hover:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand pointer-coarse:size-11"
          title={p.name}
          aria-label="{p.name} palette"
          aria-pressed={ui.palette === p.id}
          onclick={() => ui.setPalette(p.id)}
        >
          <span class="size-4 rounded-full ring-1 ring-line-strong ring-inset {ui.palette === p.id ? 'ring-2' : ''}" style="background: {p.swatch}"></span>
        </button>
      {/each}
      <span class="mx-0.5 h-5 w-px bg-line" aria-hidden="true"></span>
      <button
        type="button"
        class="interactive flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[11.5px] text-ink-muted hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand max-md:h-9"
        title={ui.theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        onclick={() => ui.toggleTheme()}
      >
        {#if ui.theme === "dark"}
          <Sun size={13} strokeWidth={1.75} aria-hidden="true" />Light
        {:else}
          <Moon size={13} strokeWidth={1.75} aria-hidden="true" />Dark
        {/if}
      </button>
    </div>
  </div>
</Popover>