<script lang="ts">
  import type { Snippet } from "svelte";

  /** A landing-page band: an id to link to, one heading, an optional lede. */
  let { id, title, lede, children, class: klass = "" }: { id: string; title: string; lede?: string; children: Snippet; class?: string } = $props();
</script>

<section {id} aria-labelledby="{id}-h" class="mx-auto w-full max-w-7xl 2xl:max-w-[90rem] px-4 py-16 sm:px-6 sm:py-24 {klass}">
  <div class="mx-auto mb-10 max-w-2xl text-center sm:mb-14">
    <h2 id="{id}-h" class="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h2>
    {#if lede}<p class="mt-3 text-lg text-muted-foreground">{lede}</p>{/if}
  </div>
  {@render children()}
</section>
