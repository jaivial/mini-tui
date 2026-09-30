<script lang="ts">
  import { AppWindow, AppWindowMac, Columns2, Rows2, SquareSplitHorizontal, Trash2, X } from "@lucide/svelte";
  import Button from "./Button.svelte";

  /**
   * The pane's own menu, tmux's `split-window` / `kill-pane` in a popover: arrows move, Enter picks,
   * Escape or a click outside closes and focus returns to the button. An action that cannot run says
   * why in its own row instead of disappearing.
   */
  let {
    tabs = false,
    canRight = true,
    canDown = true,
    limitReached = false,
    canClose = false,
    windows = [],
    onmove,
    onsplit,
    onclose,
    oncloseSession,
  }: {
    /** Offered in the menu too: in a very narrow pane the header's own button is hidden. */
    oncloseSession?: () => void;
    /** Narrow screens show panes as tabs: one "New pane" instead of two directions. */
    tabs?: boolean;
    canRight?: boolean;
    canDown?: boolean;
    limitReached?: boolean;
    canClose?: boolean;
    /** Other windows, for "Move to window…". Empty when this is the only one. */
    windows?: { id: string; label: string }[];
    onmove?: (to: string | "new", name?: string) => void;
    onsplit: (dir: "row" | "col") => void;
    onclose: () => void;
  } = $props();

  const uid = $props.id();
  let open = $state(false);
  let button = $state<HTMLElement | null>(null);
  let menu = $state<HTMLElement | null>(null);

  type Item = { id: string; label: string; hint: string; icon: typeof Columns2; disabled: string; group?: string; run: () => void };
  const items = $derived<Item[]>(
    [
      ...(tabs
        ? [{ id: "tab", label: "New pane", hint: "Ctrl \\", icon: SquareSplitHorizontal, disabled: limitReached ? "At most 12 panes" : "", run: () => onsplit("row") }]
        : [
            { id: "right", label: "Split right", hint: "Ctrl \\", icon: Columns2, disabled: limitReached ? "At most 12 panes" : canRight ? "" : "Too narrow to split", run: () => onsplit("row") },
            { id: "down", label: "Split down", hint: "Ctrl Shift \\", icon: Rows2, disabled: limitReached ? "At most 12 panes" : canDown ? "" : "Too short to split", run: () => onsplit("col") },
          ]),
      // Moving a pane: to any other window, or to a new one. Both keep its session running.
      ...windows.map((w) => ({ id: `move-${w.id}`, label: w.label, hint: "", icon: AppWindow, disabled: "", group: "Move to window", run: () => onmove?.(w.id) })),
      ...(onmove ? [{ id: "move-new", label: "New window", hint: "", icon: AppWindowMac, disabled: "", group: windows.length ? "Move to window" : "Move to a new window", run: () => onmove("new") }] : []),
      { id: "close", label: "Close pane", hint: "Alt X", icon: X, disabled: canClose ? "" : "The last pane stays", run: onclose },
      ...(oncloseSession ? [{ id: "close-session", label: "Close session", hint: "", icon: Trash2, disabled: "", run: oncloseSession }] : []),
    ],
  );

  function toggle() {
    open = !open;
    if (open) queueMicrotask(() => (menu?.querySelector('[role="menuitem"]:not([aria-disabled="true"])') as HTMLElement | null)?.focus());
  }
  function dismiss(refocus = true) {
    open = false;
    if (refocus) button?.querySelector("button")?.focus();
  }
  function pick(item: Item) {
    if (item.disabled) return;
    dismiss(false);
    item.run();
  }
  function onkeydown(event: KeyboardEvent) {
    const all = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const d = event.key === "ArrowDown" ? 1 : -1;
      all[(i + d + all.length) % all.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      all[event.key === "Home" ? 0 : all.length - 1]?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      dismiss(event.key === "Escape");
    }
  }
  $effect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menu?.contains(event.target as Node) && !button?.contains(event.target as Node)) dismiss(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  });
</script>

<div class="relative" bind:this={button}>
  <Button variant="ghost" size="icon-sm" icon={Columns2} title="Pane" aria-label="Pane menu" aria-haspopup="menu" aria-expanded={open} aria-controls="{uid}-menu" active={open} onclick={toggle} />
  {#if open}
    <div
      id="{uid}-menu"
      bind:this={menu}
      role="menu"
      tabindex="-1"
      aria-label="Pane"
      class="elev-pop enter-pop absolute top-full right-0 z-40 mt-1.5 flex w-56 flex-col rounded-lg p-1"
      {onkeydown}
    >
      {#each items as item, i (item.id)}
        {@const Icon = item.icon}
        {#if item.group && items[i - 1]?.group !== item.group}
          <div class="mt-1 mb-0.5 px-2 pt-1 text-[10px] font-semibold tracking-wider text-ink-faint uppercase">{item.group}</div>
        {/if}
        <button
          type="button"
          role="menuitem"
          aria-disabled={item.disabled ? "true" : undefined}
          class="interactive flex min-h-8 w-full items-center gap-2.5 rounded-md px-2 text-left pointer-coarse:min-h-11
            {item.disabled ? 'cursor-not-allowed text-ink-faint' : 'cursor-pointer text-ink hover:bg-raised focus-visible:bg-raised'}"
          onclick={() => pick(item)}
        >
          <Icon size={14} strokeWidth={1.75} aria-hidden="true" class="shrink-0" />
          <span class="min-w-0 flex-1">
            <span class="block text-[12.5px] leading-4">{item.label}</span>
            {#if item.disabled}<span class="block text-[11px] leading-4 text-ink-faint">{item.disabled}</span>{/if}
          </span>
          <kbd class="shrink-0 font-mono text-[10.5px] text-ink-faint pointer-coarse:hidden">{item.hint}</kbd>
        </button>
      {/each}
    </div>
  {/if}
</div>
