<script lang="ts">
  import { avatarSrc } from "../avatar";

  /**
   * One blob emoji, as an avatar (see lib/avatar.ts). Decorative by rule: the
   * session's title carries the meaning, so the image is always `aria-hidden`
   * and never interactive.
   */
  let {
    /** Stable id (the session's): it picks the face. */
    id,
    /** Square size in px. */
    size = 34,
    class: klass = "",
  }: { id: string; size?: number; class?: string } = $props();
</script>

<span
  class="relative inline-grid shrink-0 place-items-center overflow-hidden rounded-full bg-raised {klass}"
  style="width:{size}px;height:{size}px"
>
  <img src={avatarSrc(id)} alt="" aria-hidden="true" draggable="false" class="h-full w-full object-cover select-none" />
</span>
