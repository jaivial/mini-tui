<script lang="ts">
  import { avatarSrc } from "../avatar";

  /**
   * One squishmoji, as an avatar (see lib/avatar.ts). The squish IS the shape —
   * a free-form blob character, like the mockup's room of pets — so it renders
   * without a circular crop or backing tile. Decorative by rule: the session's
   * title carries the meaning, so the image is always `aria-hidden` and never
   * interactive.
   */
  let {
    /** Stable id (the session's): it picks the face. */
    id,
    /** Square size in px. */
    size = 34,
    class: klass = "",
  }: { id: string; size?: number; class?: string } = $props();
</script>

<span class="relative inline-grid shrink-0 place-items-center {klass}" style="width:{size}px;height:{size}px">
  <img src={avatarSrc(id)} alt="" aria-hidden="true" draggable="false" class="h-full w-full object-contain select-none" />
</span>
