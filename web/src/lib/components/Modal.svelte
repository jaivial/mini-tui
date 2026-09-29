<script lang="ts">
  import { X } from "@lucide/svelte";
  import type { Snippet } from "svelte";
  import Button from "./Button.svelte";

  let {
    open = $bindable(false),
    title,
    description,
    width = "max-w-lg",
    onclose,
    children,
  }: {
    open?: boolean;
    title: string;
    description?: string;
    width?: string;
    onclose: () => void;
    children: Snippet;
  } = $props();

  let dialog: HTMLDialogElement | undefined = $state();

  /*
   * The native element owns everything a hand-rolled overlay has to rebuild:
   * the top layer (no z-index war), focus containment, inertness of the page
   * behind it, and Escape. The only state left is open/closed.
   */
  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  });

  // `close` also fires for Escape, so both paths land in one place.
  function oncloseevent(event: Event) {
    event.preventDefault();
    onclose();
  }
</script>

<dialog
  bind:this={dialog}
  class="m-auto w-[calc(100vw-2rem)] bg-transparent p-0 text-ink backdrop:bg-black/40 max-sm:mb-0 max-sm:w-screen max-sm:max-w-none"
  aria-label={title}
  onclose={oncloseevent}
  onclick={(e) => {
    // A click that lands on the backdrop (outside the panel's box) dismisses.
    if (e.target === dialog) onclose();
  }}
>
  <div
    class="enter-pop sheet elev-pop flex max-h-[85dvh] w-full {width} flex-col overflow-hidden rounded-2xl max-sm:max-h-[min(92dvh,calc(100dvh-env(safe-area-inset-top)-0.75rem))] max-sm:max-w-none max-sm:rounded-b-none"
    role="document"
  >
    <div aria-hidden="true" class="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line-strong sm:hidden"></div>
    <header class="flex items-start gap-3 border-b border-line/80 px-5 py-3.5 max-sm:px-4 max-sm:pt-2">
      <div class="min-w-0 flex-1">
        <h2 class="text-[14px] leading-5 font-medium">{title}</h2>
        {#if description}
          <p class="mt-0.5 text-[12.5px] leading-4 text-ink-muted">{description}</p>
        {/if}
      </div>
      <Button variant="ghost" size="icon-sm" icon={X} title="Close" onclick={onclose} />
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] max-sm:p-4 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]">
      {@render children()}
    </div>
  </div>
</dialog>

<style>
  /* The element is centred by `m-auto`; the box is only the scroll container. */
  dialog {
    max-height: 100dvh;
    /*
     * The UA gives a modal <dialog> `overflow: auto`, which crops everything painted outside the
     * panel's box: the 1px hairline and the drop shadow of the panel are box-shadows, so on the
     * phone sheet (flush with the screen edge) the top edge lost its outline and the sheet looked
     * cut off. The panel scrolls its own body, so the dialog never needs to clip.
     */
    overflow: visible;
  }
  /* On a phone the panel rises from the bottom edge like a native sheet. */
  @media (max-width: 639px) {
    .sheet {
      animation-name: sheet-in;
    }
  }
  dialog::backdrop {
    animation: scrim-in var(--duration-base) var(--ease-standard) both;
  }
</style>
