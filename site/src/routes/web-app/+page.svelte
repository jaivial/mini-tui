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
  // What the web app gained after the screenshots above were taken (0.20 to 0.29).
  const recent = [
    { title: "Live with the terminal", body: "Open a session a terminal is running and follow the same agent here, live. A message from either one reaches it." },
    { title: "Subagents above the transcript", body: "A session's subagents in a strip: state, steps and cost. Click one to watch it live, then step back to its parent." },
    { title: "Move a pane anywhere", body: "From a pane's menu, send it to another window or to a new one. Its session keeps running on the way." },
    { title: "One workspace everywhere", body: "Your windows, panes and sidebar are kept on the server: a phone, a laptop and a second tab all show the same thing, live." },
    { title: "A status dot per pane", body: "Working, done or idle, on each window row in the sidebar. A finished turn stays marked until you click its pane." },
    { title: "Notes and a terminal", body: "Every pane has a side panel with notes that save as you type, and a real shell in the session's folder." },
  ] as const;
  const phone = [
    { src: "/screens/web-phone-chat.webp", alt: "mini-tui on a phone showing a session transcript and the prompt bar" },
    { src: "/screens/web-phone-sessions.webp", alt: "The sessions drawer open on a phone" },
  ];
</script>

<Seo
  page={{
    path: "/web-app/",
    title: "The mini-tui web app",
    description: "A browser UI for the mini-swe-agent coding agent: sessions in panes, live with the terminal, subagents, skill chips, a model switcher and a phone layout.",
    modified: "2026-10-04",
    crumbs: [{ name: "Home", path: "/" }, { name: "Web app", path: "/web-app/" }],
  }}
/>

<div class="mx-auto max-w-7xl 2xl:max-w-[90rem] px-4 py-16 sm:px-6 sm:py-24">
  <div class="mx-auto max-w-3xl text-center">
    <h1 class="text-4xl font-semibold tracking-tight sm:text-5xl">The agent, in your browser</h1>
    <p class="mt-4 text-lg text-muted-foreground">The same agent and the same session history as the terminal UI, split into panes and windows, so every session keeps working where you can see it.</p>
    <div class="mt-8 flex flex-wrap justify-center gap-3">
      <Button size="lg" href={resolve("/docs/web-app/")}>Read the guide</Button>
      <Button size="lg" variant="outline" href={resolve("/docs/install/")}>Install</Button>
    </div>
  </div>

  <figure use:reveal class="mt-16 overflow-hidden rounded-xl border bg-card shadow-[0_0_0_1px_var(--border),0_24px_60px_-24px_rgb(0_0_0/0.35)]">
    <img src={asset("/screens/web-panes.webp")} alt="Four sessions side by side in a window called Backend, three of them working; the sidebar lists the Backend, Frontend and Release windows with a status dot per pane" width="3360" height="2000" loading="lazy" decoding="async" class="block h-auto w-full" />
    <figcaption class="border-t px-4 py-3 text-sm">
      <span class="font-semibold">Panes and windows.</span>
      <span class="text-muted-foreground">Up to 12 panes in a window, each its own session, and as many windows as you like. The dots in the sidebar say which panes are working, done or idle.</span>
    </figcaption>
  </figure>

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

  <section aria-labelledby="recent-h" class="mt-24">
    <h2 id="recent-h" class="text-center text-3xl font-semibold tracking-tight">New since these screenshots</h2>
    <ul use:reveal={{ children: true }} class="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {#each recent as r (r.title)}
        <li class="min-w-0 rounded-xl border bg-card p-5">
          <h3 class="font-semibold">{r.title}</h3>
          <p class="mt-1.5 text-sm text-muted-foreground">{r.body}</p>
        </li>
      {/each}
    </ul>
  </section>

  <section aria-labelledby="phone-h" class="mt-24 grid items-center gap-10 md:grid-cols-2">
    <div class="min-w-0">
      <h2 id="phone-h" class="text-3xl font-semibold tracking-tight">Made for a phone, too</h2>
      <p class="mt-3 text-muted-foreground">44px touch targets, dialogs that rise as bottom sheets, safe-area insets and a layout that tracks the visible viewport. The prompt bar grows a line at a time and never covers the keyboard.</p>
      <ul class="mt-5 space-y-2 text-sm text-muted-foreground">
        <li>Light and dark, with six accent palettes</li>
        <li>Reduced motion respected everywhere</li>
        <li>Keyboard and screen-reader friendly</li>
      </ul>
    </div>
    <ul class="flex min-w-0 justify-center gap-3 sm:gap-4">
      {#each phone as p (p.src)}
        <li class="w-[min(10rem,calc(50%-0.375rem))] overflow-hidden rounded-[1.75rem] border bg-card sm:w-48"><img src={asset(p.src)} alt={p.alt} width="780" height="1688" loading="lazy" decoding="async" class="block h-auto w-full" /></li>
      {/each}
    </ul>
  </section>
</div>
