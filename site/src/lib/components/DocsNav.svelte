<script lang="ts">
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { docSections } from "$lib/docs-data";
  const here = (slug: string) => page.url.pathname.replace(/\/$/, "").endsWith(`/docs/${slug}`);
</script>

<nav aria-label="Documentation" class="lg:sticky lg:top-20 lg:h-fit">
  <a href={resolve("/docs/")} class="mb-3 block text-sm font-semibold hover:text-primary">All docs</a>
  {#each docSections() as section (section.name)}
    <h2 class="mt-5 mb-1 text-xs font-semibold tracking-wide text-faint uppercase">{section.name}</h2>
    <ul class="space-y-0.5">
      {#each section.pages as d (d.slug)}
        <li>
          <a href={resolve(`/docs/${d.slug}/` as "/")} aria-current={here(d.slug) ? "page" : undefined} class="block rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:font-medium aria-[current=page]:text-foreground">{d.title}</a>
        </li>
      {/each}
    </ul>
  {/each}
</nav>
