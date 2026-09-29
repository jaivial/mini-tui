<script lang="ts">
  import Seo from "$lib/components/Seo.svelte";
  import { REPO } from "$lib/site";
  let { data } = $props();
</script>

<Seo
  page={{
    path: "/changelog/",
    title: "Changelog",
    description: "Release notes for mini-tui: what changed in every version, newest first, including the 0.19 web app release.",
    type: "article",
    modified: "2026-09-29",
    crumbs: [{ name: "Home", path: "/" }, { name: "Changelog", path: "/changelog/" }],
  }}
/>

<div class="mx-auto max-w-3xl px-4 py-16 sm:px-6">
  <h1 class="text-4xl font-semibold tracking-tight">Changelog</h1>
  <p class="mt-3 text-muted-foreground">The latest releases. Older ones are in the <a class="text-primary underline underline-offset-4" href="{REPO}/blob/main/CHANGELOG.md">full changelog</a>.</p>
  {#each data.items as r (r.version)}
    <section aria-labelledby="v{r.version.replaceAll('.', '-')}" class="mt-12 border-t pt-8">
      <h2 id="v{r.version.replaceAll('.', '-')}" class="flex items-baseline gap-3 text-2xl font-semibold tracking-tight">
        {r.version}
        {#if r.date}<time datetime={r.date} class="text-sm font-normal text-faint">{r.date}</time>{/if}
      </h2>
      <div class="prose-mt">{@html r.html}</div>
    </section>
  {/each}
</div>
