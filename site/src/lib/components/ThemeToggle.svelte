<script lang="ts">
  import { Moon, Sun } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";

  // The class is set before first paint by app.html; this only flips it and remembers the choice.
  let dark = $state(true);
  $effect(() => {
    dark = document.documentElement.classList.contains("dark");
  });
  function toggle() {
    dark = !dark;
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("mt-theme", dark ? "dark" : "light");
    } catch {
      /* private mode: the choice just does not persist */
    }
  }
</script>

<!--
  Both icons stay in the DOM and cross-fade: the visible one is at scale 1 / opacity 1 / blur 0, the other
  at scale .25 / opacity 0 / blur 4px. Only scale, opacity and filter transition. The label and aria-pressed
  carry the state for anyone who cannot see the motion.
-->
<Button variant="ghost" size="icon" class="relative" onclick={toggle} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} aria-pressed={!dark} title={dark ? "Light mode" : "Dark mode"}>
  <span class="swap {dark ? 'on' : 'off'}" aria-hidden="true"><Sun /></span>
  <span class="swap {dark ? 'off' : 'on'}" aria-hidden="true"><Moon /></span>
</Button>

<style>
  .swap {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    transition-property: scale, opacity, filter;
    transition-duration: 200ms;
    transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
  }
  .on {
    scale: 1;
    opacity: 1;
    filter: blur(0px);
  }
  .off {
    scale: 0.25;
    opacity: 0;
    filter: blur(4px);
  }
</style>
