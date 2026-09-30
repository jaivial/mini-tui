<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Component } from "svelte";
  import Spinner from "./Spinner.svelte";

  type Variant = "primary" | "secondary" | "ghost" | "outline" | "subtle" | "danger";
  type Size = "xs" | "sm" | "md" | "icon" | "icon-sm";

  let {
    variant = "secondary",
    size = "md",
    icon: IconCmp,
    iconRight: IconRightCmp,
    active = false,
    loading = false,
    static: staticPress = false,
    title,
    "aria-label": ariaLabel,
    disabled = false,
    class: klass = "",
    onclick,
    children,
    ...rest
  }: {
    variant?: Variant;
    size?: Size;
    icon?: Component<any>;
    iconRight?: Component<any>;
    active?: boolean;
    /** Swap the icon for a spinner and block clicks; the button keeps its size. */
    loading?: boolean;
    /** Turn the press scale off where motion would distract. */
    static?: boolean;
    title?: string;
    /** Name for icon-only buttons (falls back to `title`). */
    "aria-label"?: string;
    disabled?: boolean;
    class?: string;
    onclick?: (event: MouseEvent) => void;
    children?: Snippet;
    /** Anything else (aria-*, data-*, id...) goes onto the <button>. */
    [attr: string]: unknown;
  } = $props();

  // Hit areas: dense with a mouse (32px), 44px under a finger. `pointer-coarse`
  // is a capability query, not a device sniff, so a touch laptop gets it too.
  const SIZES: Record<Size, string> = {
    xs: "h-6 px-2 text-[11.5px] gap-1 rounded-sm pointer-coarse:h-9 pointer-coarse:px-3",
    sm: "h-8 min-w-8 px-2.5 text-[12.5px] gap-1.5 rounded-md pointer-coarse:h-11 pointer-coarse:px-3.5 pointer-coarse:min-w-11",
    md: "h-9 px-3 text-[13.5px] gap-2 rounded-md pointer-coarse:h-11 pointer-coarse:px-4",
    icon: "h-9 w-9 rounded-md pointer-coarse:size-11",
    "icon-sm": "h-8 w-8 rounded-sm pointer-coarse:size-11 pointer-coarse:rounded-md",
  };
  // Radii nest: the padding differs per size, so the radius does too.
  const ICON_SIZES: Record<Size, number> = { xs: 12, sm: 14, md: 16, icon: 16, "icon-sm": 14 };

  // Cursor-like restraint: the primary is the only filled control in the app,
  // so it stays the one thing that reads as "do this".
  const VARIANTS: Record<Variant, string> = {
    primary: "bg-brand text-brand-ink hover:brightness-110 elev-1",
    secondary: "bg-raised text-ink hover:bg-overlay border border-line",
    subtle: "bg-raised/60 text-ink-muted hover:text-ink hover:bg-raised border border-line/70",
    ghost: "text-ink-muted hover:text-ink hover:bg-raised",
    outline: "border border-line text-ink hover:bg-raised",
    danger: "text-err hover:bg-err/10",
  };

  const iconSize = $derived(ICON_SIZES[size]);
</script>

<button
  {...rest}
  {title}
  aria-label={ariaLabel ?? (children ? undefined : title)}
  disabled={disabled || loading}
  aria-busy={loading || undefined}
  class="interactive relative inline-flex shrink-0 cursor-pointer items-center justify-center font-medium select-none
    disabled:pointer-events-none disabled:opacity-45 {SIZES[size]} {VARIANTS[variant]}
    {klass}"
  class:active-0={!staticPress && !disabled && !loading}
  data-variant={variant}
  data-active={active || undefined}
  onclick={onclick}
>
  {#if loading}
    <Spinner size={iconSize} label="Loading" class="-ml-0.5" />
  {:else if IconCmp}
    <!-- Optical alignment: a glyph's mass sits left of its box, so nudge it. -->
    <IconCmp size={iconSize} strokeWidth={size === "xs" || size === "sm" ? 2 : 1.75} class="-ml-0.5 shrink-0" />
  {/if}
  {@render children?.()}
  {#if IconRightCmp}
    <IconRightCmp size={iconSize} strokeWidth={1.75} class="-mr-0.5 shrink-0" />
  {/if}
</button>

<style>
  /* Scale on press: 0.96 exactly, and always with a static cue too. */
  button:not(.active-0):active {
    transform: scale(0.96);
  }
  button[data-active] {
    background: var(--color-brand-soft);
    color: var(--color-ink);
  }
  button[data-variant="ghost"][data-active] {
    background: var(--color-raised);
  }
</style>
