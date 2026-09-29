<script lang="ts">
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import Seo from "$lib/components/Seo.svelte";
  import { Button } from "$lib/components/ui/button";
</script>

<Seo page={{ path: "/404/", title: page.status === 404 ? "Page not found" : "Something went wrong", description: "This page does not exist on the mini-tui site. Head back to the home page or the documentation.", noindex: true }} />

<div class="mx-auto flex max-w-xl flex-col items-center px-4 py-32 text-center">
  <p class="font-mono text-sm text-primary">{page.status}</p>
  <h1 class="mt-3 text-4xl font-semibold tracking-tight">{page.status === 404 ? "That page is not here." : "Something went wrong."}</h1>
  <p class="mt-3 text-muted-foreground">Check the address, or start from the home page or the docs.</p>
  <div class="mt-8 flex gap-3">
    <Button href={resolve("/")}>Home</Button>
    <Button variant="outline" href={resolve("/docs/")}>Docs</Button>
  </div>
</div>
