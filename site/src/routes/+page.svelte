<script lang="ts">
  import { asset, resolve } from "$app/paths";
  import { ArrowRight, Play } from "@lucide/svelte";
  import { Github } from "$lib/icons";
  import Seo from "$lib/components/Seo.svelte";
  import Section from "$lib/components/Section.svelte";
  import CodeBlock from "$lib/components/CodeBlock.svelte";
  import FeatureIcon from "$lib/components/FeatureIcon.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import * as Card from "$lib/components/ui/card";
  import * as Accordion from "$lib/components/ui/accordion";
  import { faq, features, hero, screens, steps } from "$lib/content/home";
  import { reveal } from "$lib/motion";
  import { DESCRIPTION, REPO, RELEASE } from "$lib/site";
</script>

<Seo page={{ path: "/", title: "mini-tui: terminal and web UI for the mini-swe-agent", description: DESCRIPTION, faq: faq.map((f) => ({ q: f.q, a: f.a })), modified: "2026-09-29" }} />

<!-- Hero: the one <h1>, the primary action, and the product in the first viewport. -->
<div class="relative overflow-hidden border-b">
  <div class="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[520px] bg-[radial-gradient(60%_60%_at_50%_0%,color-mix(in_oklab,var(--primary)_16%,transparent),transparent)]" aria-hidden="true"></div>
  <div class="mx-auto max-w-6xl px-4 pt-16 pb-10 text-center sm:px-6 sm:pt-24">
    <Badge variant="secondary" class="mb-6 font-mono">v{RELEASE}: the web app</Badge>
    <h1 class="mx-auto max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">{hero.title}</h1>
    <p class="mx-auto mt-5 max-w-2xl text-base text-muted-foreground sm:text-lg">{hero.sub}</p>
    <div class="mt-8 flex flex-wrap items-center justify-center gap-3">
      <Button size="lg" href={resolve("/docs/install/")}>Get started <ArrowRight data-icon="inline-end" aria-hidden="true" /></Button>
      <Button size="lg" variant="outline" href={REPO}><Github data-icon="inline-start" aria-hidden="true" /> Star on GitHub</Button>
    </div>
    <p class="mt-4 font-mono text-xs text-faint">bun run web</p>

    <figure class="mx-auto mt-12 max-w-5xl">
      <div class="overflow-hidden rounded-xl border bg-card shadow-[0_0_0_1px_var(--border),0_24px_60px_-24px_rgb(0_0_0/0.35)]">
        <img src={asset(`/${screens[0].src}`)} alt={screens[0].alt} width={screens[0].w} height={screens[0].h} fetchpriority="high" decoding="async" class="block h-auto w-full" />
      </div>
    </figure>
  </div>
</div>

<Section id="features" title="Everything the agent does, in the open" lede="A UI that stays out of the way of the work, and gets out of the way faster than you can read a transcript.">
  <ul use:reveal={{ children: true }} class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
    {#each features as f (f.id)}
      <li>
        <Card.Root class="h-full">
          <Card.Header>
            <div class="mb-2 grid size-9 place-items-center rounded-lg bg-primary/10 text-primary"><FeatureIcon name={f.icon} /></div>
            <Card.Title><h3 class="text-base font-semibold">{f.title}</h3></Card.Title>
            <Card.Description>{f.body}</Card.Description>
          </Card.Header>
        </Card.Root>
      </li>
    {/each}
  </ul>
</Section>

<Section id="see-it" title="See it in motion" lede="A 24-second tour: a live session, commands and chips, the model switcher, and the phone layout.">
  <div use:reveal class="mx-auto max-w-4xl overflow-hidden rounded-xl border bg-card">
    <!-- preload="none" keeps the video off the critical path; the poster is the only thing fetched until play. -->
    <video controls preload="none" playsinline poster={asset("/media/promo-poster.webp")} width="1280" height="720" class="block h-auto w-full" aria-describedby="video-desc">
      <source src={asset("/media/promo.webm")} type="video/webm" />
      <source src={asset("/media/promo.mp4")} type="video/mp4" />
      <track kind="descriptions" srclang="en" label="Description" src={asset("/media/promo-description.vtt")} />
      Your browser cannot play this video. <a href={asset("/media/promo.mp4")}>Download the MP4</a>.
    </video>
  </div>
  <p id="video-desc" class="mx-auto mt-4 max-w-2xl text-center text-sm text-muted-foreground"><Play class="mr-1 inline size-3.5" aria-hidden="true" />The video has no sound. It shows a session streaming, the / and $ menus turning into chips, the searchable model switcher, and the layout on a phone.</p>
</Section>

<Section id="tour" title="Designed to be used, not just looked at">
  <ul use:reveal={{ children: true, gap: 0.1 }} class="grid gap-6 md:grid-cols-2">
    {#each screens.slice(1) as s (s.src)}
      <li>
        <figure class="overflow-hidden rounded-xl border bg-card">
          <img src={asset(`/${s.src}`)} alt={s.alt} width={s.w} height={s.h} loading="lazy" decoding="async" class="block h-auto w-full" />
          <figcaption class="border-t px-4 py-3 text-sm font-medium">{s.caption}</figcaption>
        </figure>
      </li>
    {/each}
  </ul>
</Section>

<Section id="start" title="Running in three steps" lede="Bun and Python. No account, no cloud.">
  <ol use:reveal={{ children: true }} class="mx-auto grid max-w-3xl gap-6">
    {#each steps as s (s.n)}
      <li class="grid gap-3 sm:grid-cols-[2.5rem_1fr]">
        <span class="grid size-9 place-items-center rounded-full border font-mono text-sm text-muted-foreground" aria-hidden="true">{s.n}</span>
        <div>
          <h3 class="mb-2 font-semibold">{s.title}</h3>
          <CodeBlock code={s.code} />
        </div>
      </li>
    {/each}
  </ol>
  <p class="mt-8 text-center text-sm text-muted-foreground">Full guide in the <a class="text-primary underline underline-offset-4" href={resolve("/docs/install/")}>install docs</a>.</p>
</Section>

<Section id="faq" title="Questions" class="max-w-3xl">
  <Accordion.Root type="single" class="w-full">
    {#each faq as f, i (f.q)}
      <Accordion.Item value={`q${i}`}>
        <Accordion.Trigger class="text-left text-base"><h3 class="font-medium">{f.q}</h3></Accordion.Trigger>
        <Accordion.Content><p class="text-muted-foreground">{f.a}</p></Accordion.Content>
      </Accordion.Item>
    {/each}
  </Accordion.Root>
</Section>

<div class="border-t bg-card/40">
  <div class="mx-auto max-w-3xl px-4 py-20 text-center sm:px-6">
    <h2 class="text-3xl font-semibold tracking-tight sm:text-4xl">Try it in a minute.</h2>
    <p class="mt-3 text-muted-foreground">No account, no subscription. Bring your own model key.</p>
    <div class="mt-8 flex flex-wrap justify-center gap-3">
      <Button size="lg" href={resolve("/docs/install/")}>Install mini-tui</Button>
      <Button size="lg" variant="outline" href={resolve("/web-app/")}>See the web app</Button>
    </div>
  </div>
</div>
