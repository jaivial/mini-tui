<script lang="ts">
  /**
   * Full-screen image viewer for chat images (what the bot made, what was attached).
   * Click an inline image and it opens here: zoom (wheel, double-click, buttons),
   * download, and Esc or a backdrop click to leave. One dialog for the whole app —
   * see lib/lightbox.svelte.ts.
   */
  import { X, ZoomIn, ZoomOut, Download } from "@lucide/svelte";
  import { lightbox, closeLightbox } from "../lightbox.svelte";

  let zoom = $state(1);
  let closeBtn = $state<HTMLButtonElement | null>(null);
  /** The element to hand focus back to when the overlay closes. */
  let restore: HTMLElement | null = null;

  const MIN = 1;
  const MAX = 4;

  $effect(() => {
    if (lightbox.open) {
      zoom = 1;
      restore = document.activeElement as HTMLElement | null;
      queueMicrotask(() => closeBtn?.focus());
      return () => {
        restore?.focus?.();
        restore = null;
      };
    }
  });

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomBy(1.25);
    } else if (event.key === "-") {
      event.preventDefault();
      zoomBy(0.8);
    }
  }

  function close() {
    closeLightbox();
  }

  function zoomBy(factor: number) {
    zoom = Math.min(MAX, Math.max(MIN, Math.round(zoom * factor * 100) / 100));
  }
</script>

<svelte:window onkeydown={lightbox.open ? onkeydown : undefined} />

{#if lightbox.open}
  <div
    class="fixed inset-0 z-50 flex flex-col bg-black/90"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    aria-label={lightbox.alt ? `Imagen: ${lightbox.alt}` : "Imagen"}
    onclick={(event) => {
      if (event.target === event.currentTarget) close();
    }}
  >
    <div class="flex items-center justify-end gap-1 p-2 pointer-coarse:p-1">
      <button
        bind:this={closeBtn}
        type="button"
        class="interactive grid size-11 cursor-pointer place-items-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
        aria-label="Reducir zoom"
        disabled={zoom <= MIN}
        onclick={() => zoomBy(0.8)}
      >
        <ZoomOut size={18} strokeWidth={2} aria-hidden="true" />
      </button>
      <span class="tnum min-w-11 text-center text-[12px] text-white/70">{Math.round(zoom * 100)}%</span>
      <button
        type="button"
        class="interactive grid size-11 cursor-pointer place-items-center rounded-md text-white/80 hover:bg-white/10 hover:text-white"
        aria-label="Ampliar zoom"
        disabled={zoom >= MAX}
        onclick={() => zoomBy(1.25)}
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
        if ((event.target as HTMLElement).tagName === "IMG") zoomBy(zoom > 1 ? 1 / zoom : 2.5);
      }}
      onwheel={(event) => {
        if ((event.target as HTMLElement).tagName === "IMG") {
          event.preventDefault();
          zoomBy(event.deltaY < 0 ? 1.12 : 0.9);
        }
      }}
    >
      {#key lightbox.src}
        <img
          src={lightbox.src}
          alt={lightbox.alt}
          class="max-h-full max-w-full rounded-md object-contain shadow-2xl transition-transform duration-150"
          style:transform="scale({zoom})"
          draggable="false"
        />
      {/key}
    </div>
  </div>
{/if}
