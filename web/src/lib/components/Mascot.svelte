<script lang="ts">
  import { petSrc, type PetMood } from "../mascot";

  /**
   * One bizbots pet, as an avatar. Decorative by rule (the row's text carries
   * the meaning, like the landing's `mk-pet-*`): always `aria-hidden`, never
   * interactive. The animation is the state: idle floats, thinking breathes
   * inside a sunset halo, `greet` waves three times on mount.
   */
  let {
    mood = "idle",
    /** Square size in px; the image fits inside it. */
    size = 32,
    /** Play the greeting wave (three swings) instead of the idle animation. */
    greet = false,
    class: klass = "",
  }: {
    mood?: PetMood;
    size?: number;
    greet?: boolean;
    class?: string;
  } = $props();

  const anim = $derived(mood === "idle" && !greet ? "pet-idle" : mood === "thinking" ? "pet-think" : greet ? "pet-wave" : "");
  const dim = $derived(mood === "offline" ? "opacity-60 saturate-[0.4]" : "");
</script>

<span class="relative inline-grid shrink-0 place-items-center {klass}" style="width:{size}px;height:{size}px">
  {#if mood === "thinking"}
    <!-- The "thinking" halo: a sunset ring pulsing behind the pet. -->
    <span class="pet-halo absolute inset-[-4px] rounded-full bg-live-soft" aria-hidden="true"></span>
  {/if}
  <img
    src={petSrc(mood)}
    alt=""
    aria-hidden="true"
    draggable="false"
    class="relative h-full w-full object-contain select-none {anim} {dim}"
  />
</span>
