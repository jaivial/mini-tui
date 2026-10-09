<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * The popover's own body, mounted into `document.body` by `Popover.svelte`. It only draws: where it
   * sits is decided by the parent, which reads `at()` every time it draws so a re-place (the window
   * scrolled, the sidebar resized) moves the card without ever remounting it.
   */
  let {
    at,
    role = "dialog",
    label,
    width = "w-72",
    oncard,
    children,
  }: {
    /** Live position in viewport pixels: a function, so the card follows every re-place. */
    at: () => { top: number; left: number };
    role?: string;
    label?: string;
    width?: string;
    /** Hands the card element up, so the parent can measure and place against it. */
    oncard: (el: HTMLElement | null) => void;
    children: Snippet;
  } = $props();
  // The element is handed up once, the first time it exists, and again when it is torn down. A guard
  // keeps it to that: reporting on every run would loop, because the parent stores the element in
  // reactive state and the card is part of it.
  let card: HTMLElement | null = $state(null);
  let reported: HTMLElement | null | undefined;
  $effect(() => {
    const el = card;
    if (el === reported) return;
    reported = el;
    oncard(el);
  });
</script>

<div
  bind:this={card}
  class="elev-pop enter-pop fixed z-[70] {width} rounded-lg border border-line bg-canvas p-2 text-left shadow-lg"
  style="top: {at().top}px; left: {at().left}px"
  role={role}
  aria-label={label}
  tabindex="-1"
>
  {@render children()}
</div>
