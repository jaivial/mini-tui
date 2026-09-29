<script lang="ts">
  import { resolve } from "$app/paths";
  import { ArrowLeft, ArrowRight } from "@lucide/svelte";
  import Seo from "$lib/components/Seo.svelte";
  import DocsNav from "$lib/components/DocsNav.svelte";
  import { readingMinutes } from "$lib/docs";
  import { REPO } from "$lib/site";

  let { data } = $props();
  const doc = $derived(data.doc);
</script>

<Seo
  page={{
    path: `/docs/${doc.slug}/`,
    title: doc.title,
    description: doc.description,
    type: "article",
    modified: "2026-09-29",
    crumbs: [{ name: "Home", path: "/" }, { name: "Docs", path: "/docs/" }, { name: doc.title, path: `/docs/${doc.slug}/` }],
  }}
/>

<div class="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[14rem_minmax(0,1fr)_12rem]">
  <DocsNav />
  <article class="min-w-0">
    <nav aria-label="Breadcrumb" class="mb-4 text-sm text-muted-foreground">
      <ol class="flex flex-wrap items-center gap-1.5">
        <li><a class="hover:text-foreground" href={resolve("/")}>Home</a></li>
        <li aria-hidden="true">/</li>
        <li><a class="hover:text-foreground" href={resolve("/docs/")}>Docs</a></li>
        <li aria-hidden="true">/</li>
        <li aria-current="page" class="text-foreground">{doc.title}</li>
      </ol>
    </nav>
    <h1 class="text-4xl font-semibold tracking-tight">{doc.title}</h1>
    <p class="mt-3 text-lg text-muted-foreground">{doc.description}</p>
    <p class="mt-3 text-xs text-faint">{readingMinutes(doc.words)} min read · <a class="underline underline-offset-2 hover:text-foreground" href="{REPO}/blob/main/site/src/content/docs/{doc.slug}.md">Edit this page</a></p>
    <div class="prose-mt mt-6">
      <!-- markdown-it renders with raw HTML disabled, from content in this repository. -->
      {@html doc.html}
    </div>
    <nav aria-label="Previous and next" class="mt-14 grid gap-3 border-t pt-6 sm:grid-cols-2">
      {#if data.prev}
        <a rel="prev" href={resolve(`/docs/${data.prev.slug}/` as "/")} class="group flex flex-col rounded-lg border p-4 hover:border-ring">
          <span class="flex items-center gap-1 text-xs text-faint"><ArrowLeft class="size-3" aria-hidden="true" /> Previous</span>
          <span class="mt-1 font-medium group-hover:text-primary">{data.prev.title}</span>
        </a>
      {:else}<span></span>{/if}
      {#if data.next}
        <a rel="next" href={resolve(`/docs/${data.next.slug}/` as "/")} class="group flex flex-col rounded-lg border p-4 text-right hover:border-ring sm:col-start-2">
          <span class="flex items-center justify-end gap-1 text-xs text-faint">Next <ArrowRight class="size-3" aria-hidden="true" /></span>
          <span class="mt-1 font-medium group-hover:text-primary">{data.next.title}</span>
        </a>
      {/if}
    </nav>
  </article>
  {#if doc.headings.length > 1}
    <aside class="hidden xl:block" aria-label="On this page">
      <div class="sticky top-20">
        <h2 class="mb-2 text-xs font-semibold tracking-wide text-faint uppercase">On this page</h2>
        <ul class="space-y-1.5 border-l pl-3 text-sm">
          {#each doc.headings as h (h.id)}
            <li class={h.level === 3 ? "pl-3" : ""}><a class="text-muted-foreground hover:text-foreground" href="#{h.id}">{h.text}</a></li>
          {/each}
        </ul>
      </div>
    </aside>
  {/if}
</div>
