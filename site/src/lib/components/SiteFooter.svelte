<script lang="ts">
  import { resolve } from "$app/paths";
  import Logo from "./Logo.svelte";
  import { REPO, RELEASE } from "$lib/site";
  import { docs } from "$lib/docs-data";
</script>

<footer class="border-t">
  <div class="mx-auto grid max-w-7xl 2xl:max-w-[90rem] gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
    <div>
      <div class="flex items-center gap-2 font-semibold tracking-tight"><Logo /> mini-tui</div>
      <p class="mt-3 max-w-xs text-sm text-muted-foreground">A terminal and web UI for the mini-swe-agent coding agent. Source on GitHub.</p>
      <p class="mt-3 font-mono text-xs text-faint">v{RELEASE}</p>
    </div>
    <nav aria-label="Docs">
      <h2 class="text-sm font-semibold">Docs</h2>
      <ul class="mt-3 space-y-2 text-sm">
        {#each docs.slice(0, 4) as d (d.slug)}
          <li><a class="text-muted-foreground hover:text-foreground" href={resolve(`/docs/${d.slug}/` as "/")}>{d.title}</a></li>
        {/each}
      </ul>
    </nav>
    <nav aria-label="More docs">
      <h2 class="text-sm font-semibold">More</h2>
      <ul class="mt-3 space-y-2 text-sm">
        {#each docs.slice(4) as d (d.slug)}
          <li><a class="text-muted-foreground hover:text-foreground" href={resolve(`/docs/${d.slug}/` as "/")}>{d.title}</a></li>
        {/each}
        <li><a class="text-muted-foreground hover:text-foreground" href={resolve("/changelog/")}>Changelog</a></li>
      </ul>
    </nav>
    <nav aria-label="Project">
      <h2 class="text-sm font-semibold">Project</h2>
      <ul class="mt-3 space-y-2 text-sm">
        <li><a class="text-muted-foreground hover:text-foreground" href={REPO}>GitHub</a></li>
        <li><a class="text-muted-foreground hover:text-foreground" href="{REPO}/releases">Releases</a></li>
        <li><a class="text-muted-foreground hover:text-foreground" href="{REPO}/issues">Report an issue</a></li>
        <li><a class="text-muted-foreground hover:text-foreground" href={resolve("/sitemap.xml" as "/")}>Sitemap</a></li>
      </ul>
    </nav>
  </div>
</footer>
