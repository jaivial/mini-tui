<script lang="ts">
  /**
   * Full-screen image viewer for chat images (what the bot made, what was attached).
   * Click an inline image and it opens here: zoom (wheel, double-click, buttons), download, and
   * Esc or a backdrop click to leave. One dialog for the whole app — see lib/lightbox.svelte.ts.
   *
   * It is a real `<dialog>` opened with `showModal()`, like Modal.svelte: that is what gives it
   * the top layer, focus containment, an inert page behind and Escape. The previous hand-rolled
   * overlay declared `role="dialog" aria-modal="true"` and got none of them — measured on the
   * deployed build, 6 of the first 12 Tab stops landed on the chat painted behind it.
   */
  import { X, ZoomIn, ZoomOut, Download } from "@lucide/svelte";
  import { lightbox, closeLightbox } from "../lightbox.svelte";
  import { ZOOM_MIN, ZOOM_MAX, ZOOM_WHEEL_IN, ZOOM_WHEEL_OUT, applyZoomAction, applyZoomToggle, lightboxAction, zoomBy } from "../lightboxModal";

  let zoom = $state(1);
  let dialog: HTMLDialogElement | undefined = $state();

  /*
   * `showModal()` owns everything a modal needs: focus moves inside and cannot leave, the rest of
   * the document goes inert, Escape closes. So the state here is only open/closed — the same
   * contract Modal.svelte keeps.
   */
  $effect(() => {
    if (!dialog) return;
    if (lightbox.open && !dialog.open) {
      zoom = 1;
      dialog.showModal();
    } else if (!lightbox.open && dialog.open) {
      dialog.close();
    }
  });

  /** Escape lands here from the native close, so both exits meet in one place. */
  function oncloseevent(event: Event) {
    event.preventDefault();
    closeLightbox();
  }

  function close() {
    closeLightbox();
  }

  function zoomStep(action: "zoom-in" | "zoom-out") {
    zoom = applyZoomAction(zoom, action);
  }

  /**
   * Keys are read only while focus is inside this dialog (the rules live in lightboxModal.ts).
   *
   * Bound to the element rather than `svelte:window` on purpose: at window level these fired with
   * focus anywhere on the page, so typing "+" in the prompt zoomed the image instead of typing a
   * plus sign — measured, "2+2" came out as "22".
   */
  function onkeydown(event: KeyboardEvent) {
    const action = lightboxAction(event.key, {
      open: lightbox.open,
      insideDialog: dialog?.contains(event.target as Node) ?? false,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
    });
    if (!action) return;
    event.preventDefault();
    if (action === "close") close();
    else zoomStep(action);
  }
</script>

<dialog
  bind:this={dialog}
  class="m-0 h-full max-h-none w-full max-w-none bg-transparent p-0 backdrop:bg-black/90"
  aria-label={lightbox.alt ? `Imagen: ${lightbox.alt}` : "Imagen"}
  onclose={oncloseevent}
  onkeydown={onkeydown}
  onclick={(event) => {
    // The dialog fills the window, so "the backdrop" is its own padding: a click that lands on
    // the dialog rather than the panel or the image dismisses.
    if (event.target === dialog) close();
  }}
>
  <div class="flex h-full flex-col">
    <div class="flex items-center justify-end gap-1 p-2 pointer-coarse:p-1">
      <button
        type="button"
        class="interactive grid size-11 cursor-pointer place-items-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
        aria-label="Reducir zoom"
        disabled={zoom <= ZOOM_MIN}
        onclick={() => zoomStep("zoom-out")}
      >
        <ZoomOut size={18} strokeWidth={2} aria-hidden="true" />
      </button>
      <span class="tnum min-w-11 text-center text-[12px] text-white/70">{Math.round(zoom * 100)}%</span>
      <button
        type="button"
        class="interactive grid size-11 cursor-pointer place-items-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
        aria-label="Ampliar zoom"
        disabled={zoom >= ZOOM_MAX}
        onclick={() => zoomStep("zoom-in")}
      >
        <ZoomIn size={18} strokeWidth={2} aria-hidden="true" />
      </button>
      <a
        class="interactive grid size-11 place-items-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
        href="{lightbox.src}?dl=1"
        download
        aria-label="Descargar imagen"
        title="Descargar"
      >
        <Download size={18} strokeWidth={2} aria-hidden="true" />
      </a>
      <button
        type="button"
        class="interactive grid size-11 cursor-pointer place-items-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
        aria-label="Cerrar imagen"
        onclick={close}
      >
        <X size={18} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
    <div
      class="flex flex-1 items-center justify-center overflow-auto p-4"
      onclick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      ondblclick={(event) => {
        if ((event.target as HTMLElement).tagName === "IMG") zoom = applyZoomToggle(zoom);
      }}
      onwheel={(event) => {
        if ((event.target as HTMLElement).tagName === "IMG") {
          event.preventDefault();
          zoom = zoomBy(zoom, event.deltaY < 0 ? ZOOM_WHEEL_IN : ZOOM_WHEEL_OUT);
        }
      }}
    >
      {#if lightbox.src}
      {#key lightbox.src}
        <img
          src={lightbox.src}
          alt={lightbox.alt}
          class="max-h-full max-w-full rounded-md object-contain shadow-2xl transition-transform duration-150"
          style:transform="scale({zoom})"
          draggable="false"
        />
      {/key}
      {/if}
    </div>
  </div>
</dialog>
