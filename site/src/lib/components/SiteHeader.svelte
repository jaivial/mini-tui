<script lang="ts">
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { Menu, X } from "@lucide/svelte";
  import { Github } from "$lib/icons";
  import Logo from "./Logo.svelte";
  import ThemeToggle from "./ThemeToggle.svelte";
  import { Button } from "$lib/components/ui/button";
  import { REPO } from "$lib/site";

  const links = [
    { href: "/docs/", label: "Docs" },
    { href: "/web-app/", label: "Web app" },
    { href: "/changelog/", label: "Changelog" },
  ] as const;

  let open = $state(false);
  const here = (href: string) => page.url.pathname.replace(/\/$/, "") === resolve(href as "/").replace(/\/$/, "") || (href === "/docs/" && page.url.pathname.includes("/docs"));

  // A route change closes the menu; Escape closes it too and returns focus to its button.
  $effect(() => {
    page.url.pathname;
    open = false;
  });
  // `null`, not undefined: the shadcn Button declares `ref = $bindable(null)`, and Svelte 5 throws
  // props_invalid_value (which aborts hydration of the whole layout) when a bound value starts undefined.
  let toggle: HTMLElement | null = $state(null);
  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && open) {
      open = false;
      toggle?.focus();
    }
  }
</script>

<svelte:window {onkeydown} />

<a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground">Skip to content</a>

<header class="sticky top-0 z-50 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
  <div class="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:px-6">
    <a href={resolve("/")} class="mr-2 flex min-h-11 items-center gap-2 font-semibold tracking-tight" aria-label="mini-tui home">
      <Logo /> <span>mini-tui</span>
    </a>
    <nav aria-label="Main" class="hidden items-center gap-1 md:flex">
      {#each links as l (l.href)}
        <a href={resolve(l.href)} aria-current={here(l.href) ? "page" : undefined} class="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:text-foreground">{l.label}</a>
      {/each}
    </nav>
    <div class="ml-auto flex items-center gap-1">
      <Button variant="ghost" size="icon" href={REPO} aria-label="mini-tui on GitHub" title="GitHub"><Github aria-hidden="true" /></Button>
      <ThemeToggle />
      <Button size="sm" href={resolve("/docs/install/")} class="hidden sm:inline-flex">Get started</Button>
      <Button bind:ref={toggle} variant="ghost" size="icon" class="md:hidden" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} aria-controls="mobile-nav" onclick={() => (open = !open)}>
        {#if open}<X aria-hidden="true" />{:else}<Menu aria-hidden="true" />{/if}
      </Button>
    </div>
  </div>
  {#if open}
    <nav id="mobile-nav" aria-label="Mobile" class="border-t bg-background md:hidden">
      <ul class="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-3">
        {#each links as l (l.href)}
          <li><a href={resolve(l.href)} class="flex min-h-11 items-center rounded-md px-3 text-base text-foreground hover:bg-muted">{l.label}</a></li>
        {/each}
        <li><a href={resolve("/docs/install/")} class="flex min-h-11 items-center rounded-md bg-primary px-3 text-base font-medium text-primary-foreground">Get started</a></li>
      </ul>
    </nav>
  {/if}
</header>
