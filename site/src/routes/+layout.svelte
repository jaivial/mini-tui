<script lang="ts">
  import "../app.css";
  import type { Snippet } from "svelte";
  import SiteHeader from "$lib/components/SiteHeader.svelte";
  import SiteFooter from "$lib/components/SiteFooter.svelte";

  let { children }: { children: Snippet } = $props();
</script>

<SiteHeader />
<main id="main" tabindex="-1" class="min-h-[70vh] outline-none">
  {@render children()}
</main>
<SiteFooter />
