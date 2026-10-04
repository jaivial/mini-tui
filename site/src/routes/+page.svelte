<script lang="ts">
  import { asset, resolve } from "$app/paths";
  import { ArrowRight, Check, Play } from "@lucide/svelte";
  import { Github } from "$lib/icons";
  import Seo from "$lib/components/Seo.svelte";
  import Section from "$lib/components/Section.svelte";
  import CodeBlock from "$lib/components/CodeBlock.svelte";
  import FeatureIcon from "$lib/components/FeatureIcon.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import * as Card from "$lib/components/ui/card";
  import * as Accordion from "$lib/components/ui/accordion";
  import { agents, faq, features, hero, RUST_INSTALL, screens, steps, workspacePoints, workspaceShots } from "$lib/content/home";
  import { reveal } from "$lib/motion";
  import { DESCRIPTION, REPO, RELEASE } from "$lib/site";
</script>

<Seo page={{ path: "/", title: "mini-tui: terminal and web UI for the mini-swe-agent", description: DESCRIPTION, faq: faq.map((f) => ({ q: f.q, a: f.a })), modified: "2026-10-04" }} />

<!-- Hero: the one <h1>, the primary action, and the product in the first viewport. -->
<div class="relative overflow-hidden border-b">
  <div class="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[520px] bg-[radial-gradient(60%_60%_at_50%_0%,color-mix(in_oklab,var(--primary)_16%,transparent),transparent)]" aria-hidden="true"></div>
  <div class="mx-auto max-w-7xl 2xl:max-w-[90rem] px-4 pt-16 pb-10 text-center sm:px-6 sm:pt-24">
    <Badge variant="secondary" class="mb-6 font-mono">v{RELEASE}: panes, windows and a Rust agent</Badge>
    <h1 class="mx-auto max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">{hero.title}</h1>
    <p class="mx-auto mt-5 max-w-2xl text-base text-muted-foreground sm:text-lg">{hero.sub}</p>
    <div class="mt-8 flex flex-wrap items-center justify-center gap-3">
      <Button size="lg" href={resolve("/docs/install/")}>Get started <ArrowRight data-icon="inline-end" aria-hidden="true" /></Button>
      <Button size="lg" variant="outline" href={REPO}><Github data-icon="inline-start" aria-hidden="true" /> Star on GitHub</Button>
    </div>
    <p class="mt-4 font-mono text-xs text-faint">bun run web</p>

    <figure class="mx-auto mt-12 max-w-5xl">
      <div class="overflow-hidden rounded-xl border bg-card shadow-[0_0_0_1px_var(--border),0_24px_60px_-24px_rgb(0_0_0/0.35)]">
        <img src={asset(`/${workspaceShots.main.src}`)} alt={workspaceShots.main.alt} width={workspaceShots.main.w} height={workspaceShots.main.h} fetchpriority="high" decoding="async" class="block h-auto w-full" />
      </div>
    </figure>
  </div>
</div>

<Section id="features" title="Everything the agent does, in the open" lede="A UI that stays out of the way of the work, and gets out of the way faster than you can read a transcript.">
  <ul use:reveal={{ children: true }} class="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
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

<Section id="panes" title="Every session at once, in panes and windows" lede="Split the screen like tmux, group the panes into windows, and keep an eye on all of them from the sidebar. It is the same layout on every device you open it on.">
  <div use:reveal class="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,2fr)] lg:items-center">
    <figure class="min-w-0 overflow-hidden rounded-xl border bg-card">
      <img src={asset(`/${workspaceShots.move.src}`)} alt={workspaceShots.move.alt} width={workspaceShots.move.w} height={workspaceShots.move.h} loading="lazy" decoding="async" class="block h-auto w-full" />
      <figcaption class="border-t px-4 py-3 text-sm font-medium">Move a pane to another window, or to a new one</figcaption>
    </figure>
    <figure class="mx-auto w-full max-w-[16rem] min-w-0 overflow-hidden rounded-[1.75rem] border bg-card lg:max-w-none">
      <img src={asset(`/${workspaceShots.phone.src}`)} alt={workspaceShots.phone.alt} width={workspaceShots.phone.w} height={workspaceShots.phone.h} loading="lazy" decoding="async" class="block h-auto w-full" />
      <figcaption class="border-t px-4 py-3 text-center text-sm font-medium">Same windows on a phone</figcaption>
    </figure>
  </div>
  <ul use:reveal={{ children: true }} class="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {#each workspacePoints as p (p.title)}
      <li class="min-w-0 rounded-xl border bg-card p-5">
        <h3 class="font-semibold">{p.title}</h3>
        <p class="mt-1.5 text-sm text-muted-foreground">{p.body}</p>
      </li>
    {/each}
  </ul>
  <p class="mt-8 text-center text-sm">
    <a class="inline-flex min-h-11 items-center gap-1 text-primary underline underline-offset-4" href={resolve("/docs/web-app/" as "/")}>How panes and windows work <ArrowRight class="size-3.5" aria-hidden="true" /></a>
  </p>
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
    {#each screens as s (s.src)}
      <li>
        <figure class="overflow-hidden rounded-xl border bg-card">
          <img src={asset(`/${s.src}`)} alt={s.alt} width={s.w} height={s.h} loading="lazy" decoding="async" class="block h-auto w-full" />
          <figcaption class="border-t px-4 py-3 text-sm font-medium">{s.caption}</figcaption>
        </figure>
      </li>
    {/each}
  </ul>
</Section>

<Section id="agents" title="Python or Rust, your choice" lede="The same agent behind the UI, in two builds. The Rust one is a single binary: it starts in under a millisecond and holds a fraction of the memory.">
  <div use:reveal class="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
    <div class="min-w-0">
      <!-- A real table where there is room; stacked, labelled rows on a phone (no sideways scroll). -->
      <table class="hidden w-full border-separate border-spacing-0 overflow-hidden rounded-xl border text-sm sm:table">
        <caption class="sr-only">Python agent and Rust agent compared</caption>
        <thead>
          <tr class="bg-card">
            <th scope="col" class="w-[38%] border-b px-4 py-3 text-left font-medium text-muted-foreground"><span class="sr-only">Measure</span></th>
            <th scope="col" class="border-b px-4 py-3 text-left font-semibold">Python agent</th>
            <th scope="col" class="border-b bg-primary/5 px-4 py-3 text-left font-semibold text-primary">Rust agent</th>
          </tr>
        </thead>
        <tbody>
          {#each agents.rows as r, i (r.label)}
            <tr>
              <th scope="row" class="px-4 py-3 text-left font-medium {i < agents.rows.length - 1 ? 'border-b' : ''}">{r.label}</th>
              <td class="px-4 py-3 tabular-nums text-muted-foreground {i < agents.rows.length - 1 ? 'border-b' : ''}">{r.python}</td>
              <td class="bg-primary/5 px-4 py-3 font-medium tabular-nums {i < agents.rows.length - 1 ? 'border-b' : ''}">{r.rust}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      <dl class="grid gap-3 sm:hidden">
        {#each agents.rows as r (r.label)}
          <div class="rounded-xl border bg-card p-4">
            <dt class="text-sm font-medium">{r.label}</dt>
            <dd class="mt-2 grid grid-cols-2 gap-3 text-sm">
              <span class="min-w-0"><span class="block text-xs text-faint">Python</span><span class="tabular-nums text-muted-foreground">{r.python}</span></span>
              <span class="min-w-0"><span class="block text-xs text-primary">Rust</span><span class="font-medium tabular-nums">{r.rust}</span></span>
            </dd>
          </div>
        {/each}
      </dl>
      <p class="mt-3 text-xs text-faint">Same scripted task on one Linux box, median of five runs. A real turn spends most of its time waiting for the model, which is the same with both.</p>
      <ul class="mt-6 grid gap-2.5 text-sm text-muted-foreground">
        {#each agents.points as p (p)}
          <li class="flex gap-2.5"><Check class="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" /><span class="min-w-0">{p}</span></li>
        {/each}
      </ul>
    </div>
    <div class="min-w-0">
      <h3 class="mb-2 font-semibold">Install the Rust agent</h3>
      <p class="mb-3 text-sm text-muted-foreground">One static binary for any x86-64 Linux. mini-tui finds it there and uses it.</p>
      <CodeBlock code={RUST_INSTALL} label="Copy the install command" />
      <p class="mt-2 text-sm">
        <a class="inline-flex min-h-11 items-center gap-1 text-primary underline underline-offset-4" href={resolve("/docs/rust-agent/" as "/")}>Python or Rust: the full comparison <ArrowRight class="size-3.5" aria-hidden="true" /></a>
      </p>
    </div>
  </div>
</Section>

<Section id="start" title="Running in four steps" lede="Bun and one binary. No account, no cloud, no Python needed.">
  <ol use:reveal={{ children: true }} class="mx-auto grid w-full max-w-4xl gap-6">
    {#each steps as s (s.n)}
      <li class="grid min-w-0 gap-3 sm:grid-cols-[2.5rem_minmax(0,1fr)]">
        <span class="grid size-9 place-items-center rounded-full border font-mono text-sm text-muted-foreground" aria-hidden="true">{s.n}</span>
        <div class="min-w-0">
          <h3 class="mb-2 font-semibold">{s.title}</h3>
          <CodeBlock code={s.code} />
        </div>
      </li>
    {/each}
  </ol>
  <p class="mt-8 text-center text-sm text-muted-foreground">Full guide in the <a class="text-primary underline underline-offset-4" href={resolve("/docs/install/")}>install docs</a>.</p>
</Section>

<Section id="faq" title="Questions" class="max-w-4xl">
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
