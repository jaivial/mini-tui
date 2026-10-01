<script lang="ts">
  import { buildMeta, jsonLd, safeJson, type Page } from "$lib/seo";

  /** Everything a crawler or a link preview reads, from one Page description. Prerendered into <head>. */
  let { page }: { page: Page } = $props();
  const meta = $derived(buildMeta(page));
  const ld = $derived(safeJson(jsonLd(page)));
</script>

<svelte:head>
  <title>{meta.title}</title>
  <meta name="description" content={meta.description} />
  <meta name="robots" content={meta.robots} />
  <link rel="canonical" href={meta.canonical} />
  {#each Object.entries(meta.og) as [property, content] (property)}
    <meta {property} {content} />
  {/each}
  {#each Object.entries(meta.twitter) as [name, content] (name)}
    <meta {name} {content} />
  {/each}
  {@html `<script type="application/ld+json">${ld}</script>`}
</svelte:head>
