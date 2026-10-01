<script lang="ts">
  import { asset, resolve } from "$app/paths";
  import Seo from "$lib/components/Seo.svelte";
  import { Button } from "$lib/components/ui/button";
  import { reveal } from "$lib/motion";

  const shots = [
    { src: "/screens/web-new-chat.webp", alt: "An empty new chat: What should we work on? with Commands and Skills starters", title: "A new chat is a draft", body: "Nothing is created on the server until you send your first message, on the model and host you picked." },
    { src: "/screens/web-chips.webp", alt: "A skill chip above the prompt field, with the typed text below it", title: "Commands and skills become chips", body: "Type / or $, pick, and the choice lifts out of the text into a chip. It joins your message only when you send." },
    { src: "/screens/web-model-picker.webp", alt: "The model switcher open above the prompt bar, grouped by provider", title: "A model switcher that keeps up", body: "Search, arrow keys and Enter. Grouped by provider, and a model that is not listed can be typed." },
    { src: "/screens/web-settings-providers.webp", alt: "Settings, Providers tab: connected providers with masked keys", title: "Providers, tested before saved", body: "A key is checked with one real request first, then stored on your machine. The browser only ever sees a masked hint." },
  ];
  const phone = [
    { src: "/screens/web-phone-chat.webp", alt: "mini-tui on a phone showing a session transcript and the prompt bar" },
    { src: "/screens/web-phone-sessions.webp", alt: "The sessions drawer open on a phone" },
  ];
</script>

<Seo
  page={{
    path: "/web-app/",
    title: "The mini-tui web app",
    description: "A browser UI for the mini-swe-agent coding agent: several sessions at once, one WebSocket each, draft chats, command and skill chips, a model switcher, and a phone layout.",
    modified: "2026-09-29",
    crumbs: [{ name: "Home", path: "/" }, { name: "Web app", path: "/web-app/" }],
  }}
/>

<div class="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
  <div class="mx-auto max-w-3xl text-center">
    <h1 class="text-4xl font-semibold tracking-tight sm:text-5xl">The agent, in your browser</h1>
    <p class="mt-4 text-lg text-muted-foreground">The same agent and the same session history as the terminal UI, with a sidebar of sessions that keep working while you look at another.</p>
    <div class="mt-8 flex justify-center gap-3">
      <Button size="lg" href={resolve("/docs/web-app/")}>Read the guide</Button>
      <Button size="lg" variant="outline" href={resolve("/docs/install/")}>Install</Button>
    </div>
  </div>

  <ul use:reveal={{ children: true, gap: 0.1 }} class="mt-16 grid gap-10 md:grid-cols-2">
    {#each shots as s (s.src)}
      <li>
        <figure>
          <div class="overflow-hidden rounded-xl border bg-card"><img src={asset(s.src)} alt={s.alt} width="2880" height="1800" loading="lazy" decoding="async" class="block h-auto w-full" /></div>
          <figcaption class="mt-4">
            <h2 class="text-lg font-semibold">{s.title}</h2>
            <p class="mt-1 text-muted-foreground">{s.body}</p>
          </figcaption>
        </figure>
      </li>
    {/each}
  </ul>

  <section aria-labelledby="phone-h" class="mt-24 grid items-center gap-10 md:grid-cols-2">
    <div>
      <h2 id="phone-h" class="text-3xl font-semibold tracking-tight">Made for a phone, too</h2>
      <p class="mt-3 text-muted-foreground">44px touch targets, dialogs that rise as bottom sheets, safe-area insets and a layout that tracks the visible viewport. The prompt bar grows a line at a time and never covers the keyboard.</p>
      <ul class="mt-5 space-y-2 text-sm text-muted-foreground">
        <li>Light and dark, with six accent palettes</li>
        <li>Reduced motion respected everywhere</li>
        <li>Keyboard and screen-reader friendly</li>
      </ul>
    </div>
    <ul class="flex justify-center gap-4">
      {#each phone as p (p.src)}
        <li class="w-40 overflow-hidden rounded-[1.75rem] border bg-card sm:w-48"><img src={asset(p.src)} alt={p.alt} width="780" height="1688" loading="lazy" decoding="async" class="block h-auto w-full" /></li>
      {/each}
    </ul>
  </section>
</div>
