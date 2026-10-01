<script lang="ts">
  import { resolve } from "$app/paths";
  import Seo from "$lib/components/Seo.svelte";
  import DocsNav from "$lib/components/DocsNav.svelte";
  import * as Card from "$lib/components/ui/card";
  import { docSections, docs } from "$lib/docs-data";
  import { readingMinutes } from "$lib/docs";
</script>

<Seo
  page={{
    path: "/docs/",
    title: "Documentation",
    description: "Guides for mini-tui: install it, run the web app, use commands and skills, connect model providers, run the agent over SSH, and script it headlessly.",
    type: "article",
    modified: "2026-10-01",
    crumbs: [{ name: "Home", path: "/" }, { name: "Docs", path: "/docs/" }],
  }}
/>

<div class="mx-auto grid max-w-7xl 2xl:max-w-[90rem] gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
  <DocsNav />
  <div>
    <h1 class="text-4xl font-semibold tracking-tight">Documentation</h1>
    <p class="mt-3 max-w-2xl text-lg text-muted-foreground">Everything mini-tui does, one short page at a time.</p>
    {#each docSections() as section (section.name)}
      <h2 class="mt-12 mb-4 text-sm font-semibold tracking-wide text-faint uppercase">{section.name}</h2>
      <ul class="grid gap-4 sm:grid-cols-2">
        {#each section.pages as d (d.slug)}
          <li>
            <a href={resolve(`/docs/${d.slug}/` as "/")} class="block h-full rounded-xl outline-offset-4 transition-shadow hover:shadow-[0_0_0_1px_var(--ring)] focus-visible:shadow-[0_0_0_1px_var(--ring)]">
              <Card.Root class="h-full">
                <Card.Header>
                  <Card.Title><h3 class="text-base font-semibold">{d.title}</h3></Card.Title>
                  <Card.Description>{d.description}</Card.Description>
                </Card.Header>
                <Card.Content><span class="text-xs text-faint">{readingMinutes(d.words)} min read</span></Card.Content>
              </Card.Root>
            </a>
          </li>
        {/each}
      </ul>
    {/each}
    <p class="sr-only">{docs.length} guides.</p>
  </div>
</div>
