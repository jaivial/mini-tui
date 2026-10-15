<script lang="ts">
  import { avatarSrc } from "../avatar";

  /**
   * The chat's pet: the session's own squishmoji (same face as its avatars —
   * the hash of the id picks it) floating over the bottom-right corner of the
   * pane, the way the mockup's characters lounge beside the conversation. It
   * is an overlay, not content: it never takes a pointer event, so nothing
   * under it loses a click, and its idle bob is dropped for people who prefer
   * reduced motion.
   */
  let {
    /** Stable id whose face floats here (the session's, or the pane's for a new chat). */
    id,
  }: { id: string } = $props();
</script>

<img src={avatarSrc(id)} alt="" aria-hidden="true" draggable="false" class="mascot" />

<style>
  .mascot {
    position: absolute;
    right: 0.75rem;
    /* Above the floating prompt pill, lounging between it and the content — never over the input. */
    bottom: calc(7rem + env(safe-area-inset-bottom));
    z-index: 20;
    width: 64px;
    height: 64px;
    object-fit: contain;
    pointer-events: none;
    user-select: none;
    filter: drop-shadow(0 5px 10px oklch(0 0 0 / 0.16));
    animation: mascot-bob 6s ease-in-out infinite;
  }
  /* A narrower pane gets a smaller pet, so it never crowds the thread. */
  @container pane (width < 44rem) {
    .mascot {
      right: 0.625rem;
      width: 48px;
      height: 48px;
    }
  }
  /* A very wide pane keeps the pill centered with room to spare: the pet drops back to the corner. */
  @container pane (width >= 60rem) {
    .mascot {
      bottom: calc(1rem + env(safe-area-inset-bottom));
    }
  }
  @keyframes mascot-bob {
    0%,
    100% {
      translate: 0 0;
    }
    50% {
      translate: 0 -5px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .mascot {
      animation: none;
    }
  }
</style>
