<script lang="ts">
  import { LoaderCircle } from "@lucide/svelte";

  // A status region with a text alternative: sighted users see the arc, assistive
  // tech hears `label`. It keeps turning under reduced motion (see `.keep-motion`).
  let { size = 14, label = "Loading", class: klass = "" }: { size?: number; label?: string; class?: string } = $props();
</script>

<span role="status" class="keep-motion inline-flex shrink-0 {klass}">
  <LoaderCircle {size} strokeWidth={2} class="spin-slow" aria-hidden="true" />
  <span class="sr-only">{label}</span>
</span>
