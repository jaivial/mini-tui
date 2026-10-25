<script lang="ts">
  import { asset, resolve } from "$app/paths";
  import { ArrowRight } from "@lucide/svelte";
  import { Github } from "$lib/icons";
  import Seo from "$lib/components/Seo.svelte";
  import Section from "$lib/components/Section.svelte";
  import CodeBlock from "$lib/components/CodeBlock.svelte";
  import FeatureIcon from "$lib/components/FeatureIcon.svelte";
  import BoardMock from "$lib/components/home/BoardMock.svelte";
  import PhoneMock from "$lib/components/home/PhoneMock.svelte";
  import BrowserMock from "$lib/components/home/BrowserMock.svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Accordion from "$lib/components/ui/accordion";
  import { cuPoints, faq, features, flow, hero, oracleBench, steps, whatsappPoints } from "$lib/content/home";
  import { reveal } from "$lib/motion";
  import { DESCRIPTION, REPO, RELEASE } from "$lib/site";
</script>

<Seo page={{ path: "/", title: "mini-tui: verified work, 2.43× faster", description: DESCRIPTION, faq: faq.map((f) => ({ q: f.q, a: f.a })), modified: "2026-10-25" }} />

<div class="relative overflow-hidden border-b">
  <div class="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
    <div class="absolute inset-x-0 top-0 h-[640px] bg-[radial-gradient(55%_60%_at_50%_0%,color-mix(in_oklab,var(--ring)_22%,transparent),transparent)]"></div>
    <div class="absolute inset-0 opacity-[0.35] [background-image:linear-gradient(var(--border)_1px,transparent_1px),linear-gradient(90deg,var(--border)_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(70%_55%_at_50%_0%,#000,transparent)]"></div>
  </div>
  <div class="mx-auto max-w-7xl 2xl:max-w-[90rem] px-4 pt-16 pb-28 text-center sm:px-6 sm:pt-24">
    <a href={resolve("/changelog/")} class="mb-7 inline-flex min-h-11 items-center gap-2 rounded-full border bg-card/60 px-3.5 py-1.5 font-mono text-xs text-muted-foreground backdrop-blur transition-colors hover:text-foreground">
      <span class="size-1.5 rounded-full bg-[var(--lime)]"></span> {hero.kicker} <ArrowRight class="size-3" aria-hidden="true" />
    </a>
    <h1 class="mx-auto max-w-4xl bg-gradient-to-b from-foreground to-foreground/55 bg-clip-text text-5xl font-semibold tracking-[-0.035em] text-transparent sm:text-7xl">{hero.title}</h1>
    <p class="mx-auto mt-6 max-w-2xl text-base text-muted-foreground sm:text-lg">{hero.sub}</p>
    <div class="mt-9 flex flex-wrap items-center justify-center gap-3">
      <Button size="lg" href={resolve("/docs/install/")} class="rounded-full px-6">Start a task <ArrowRight data-icon="inline-end" aria-hidden="true" /></Button>
      <Button size="lg" variant="outline" href={resolve("/graphics/")} class="rounded-full px-6">See the evidence</Button>
      <Button size="lg" variant="ghost" href={REPO} class="rounded-full px-6"><Github data-icon="inline-start" aria-hidden="true" /> GitHub</Button>
    </div>
    <p class="mt-4 font-mono text-xs text-faint">bun run web · or docker compose up -d --build mini-tui</p>
    <figure class="relative mx-auto mt-14 max-w-5xl">
      <BoardMock />
      <div class="pointer-events-none absolute -right-4 -bottom-24 hidden w-56 lg:block xl:-right-20 xl:w-60"><div class="origin-bottom-right scale-[0.82] [filter:drop-shadow(0_30px_40px_rgb(0_0_0/0.4))]"><PhoneMock /></div></div>
      <figcaption class="sr-only">The current work queue: dispatcher, parallel workers, verify.sh passing, and a human browser handoff.</figcaption>
    </figure>
  </div>
</div>

<div class="border-b bg-card/40">
  <dl class="mx-auto grid max-w-5xl gap-px px-4 py-10 text-center sm:grid-cols-3 sm:px-6">
    <div class="px-4 py-3"><dt class="text-sm text-muted-foreground">Tasks passed, mini and pi</dt><dd class="mt-1 font-mono text-3xl font-semibold tracking-tight">10 / 10</dd></div>
    <div class="px-4 py-3"><dt class="text-sm text-muted-foreground">Assigned-worker speedup</dt><dd class="mt-1 font-mono text-3xl font-semibold tracking-tight">2.43×</dd></div>
    <div class="px-4 py-3"><dt class="text-sm text-muted-foreground">End-to-end, dispatcher included</dt><dd class="mt-1 font-mono text-3xl font-semibold tracking-tight">1.84×</dd></div>
  </dl>
</div>

<Section id="how" title="One chat. The right amount of parallelism." lede="mini-tui routes work instead of making every task a monologue. Small jobs stay direct; independent parts fan out safely.">
  <ol use:reveal={{ children: true }} class="grid gap-4 md:grid-cols-3">
    {#each flow as f (f.n)}
      <li class="group relative overflow-hidden rounded-3xl border bg-card p-7 transition-colors hover:bg-accent/40">
        <span class="font-mono text-sm text-faint">{f.n}</span>
        <h3 class="mt-6 text-xl font-semibold tracking-tight">{f.title}</h3>
        <p class="mt-2 text-muted-foreground">{f.body}</p>
        <div class="pointer-events-none absolute -right-10 -bottom-10 size-36 rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--ring)_25%,transparent),transparent_70%)] opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true"></div>
      </li>
    {/each}
  </ol>
</Section>

<Section id="queue" title="A queue you can steer, not a black box" lede="Watch the worker, redirect it with its context intact, or take over the browser when a person is needed.">
  <div use:reveal class="grid min-w-0 items-center gap-12 lg:grid-cols-2">
    <div class="order-2 lg:order-1"><PhoneMock /></div>
    <ul class="order-1 grid gap-4 lg:order-2">
      {#each whatsappPoints as p (p.title)}
        <li class="rounded-2xl border bg-card p-5">
          <h3 class="font-semibold">{p.title}</h3>
          <p class="mt-1 text-sm text-muted-foreground">{p.body}</p>
        </li>
      {/each}
    </ul>
  </div>
</Section>

<Section id="mcp" title="Native MCP, with the human step built in" lede="Remote tools use one protocol. A live browser is there when OAuth, a QR code or a captcha needs a person instead of another retry.">
  <div use:reveal class="grid min-w-0 items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
    <ul class="grid gap-4">
      {#each cuPoints as p (p.title)}
        <li class="rounded-2xl border bg-card p-5">
          <h3 class="font-semibold">{p.title}</h3>
          <p class="mt-1 text-sm text-muted-foreground">{p.body}</p>
        </li>
      {/each}
    </ul>
    <BrowserMock />
  </div>
</Section>

<Section id="proof" title="2.43× worker speed, with receipts" lede="The final strict comparison uses the same MiMo model, endpoint and verifier on both harnesses. Every PASS is independently checked.">
  <div use:reveal class="mx-auto max-w-3xl overflow-hidden rounded-3xl border bg-card">
    <div class="border-b bg-gradient-to-b from-accent/60 to-transparent p-8 text-center">
      <p class="text-sm text-muted-foreground">24 October 2026 · final strict validation · MiMo V2.6 Flash</p>
      <p class="mt-2 font-mono text-4xl font-semibold tracking-tight sm:text-5xl">{oracleBench.headline}</p>
      <p class="mt-1 text-sm text-muted-foreground">sum of per-task times, mini worker first: <span class="font-mono text-foreground">{oracleBench.ratio}</span> of pi's time</p>
    </div>
    <table class="w-full text-sm">
      <caption class="sr-only">Final strict validation for pi and mini-tui</caption>
      <thead><tr class="text-left text-muted-foreground"><th class="px-6 py-3 font-medium" scope="col">Measure</th><th class="px-4 py-3 font-medium" scope="col">pi</th><th class="px-6 py-3 font-medium" scope="col">mini-tui</th></tr></thead>
      <tbody>
        {#each oracleBench.rows as r (r.label)}
          <tr class="border-t"><th class="px-6 py-3 text-left font-normal" scope="row">{r.label}</th><td class="px-4 py-3 font-mono">{r.pi}</td><td class="px-6 py-3 font-mono font-semibold">{r.mini}</td></tr>
        {/each}
      </tbody>
    </table>
    <p class="border-t px-6 py-4 text-xs text-muted-foreground">{oracleBench.caveats} <a class="text-foreground underline underline-offset-4" href="{REPO}/blob/main/docs/ANALYSIS-mini-x2-20261024.md">Read the full analysis and raw run paths</a>.</p>
  </div>
</Section>

<Section id="features" title="The rest of the production path" lede="The queue is only useful if the whole system is observable, deployable and honest about its limits.">
  <ul use:reveal={{ children: true }} class="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
    {#each features as f (f.id)}
      <li>
        <div class="h-full rounded-2xl border bg-card p-5 transition-colors hover:bg-accent/40">
          <div class="mb-3 grid size-9 place-items-center rounded-xl border bg-gradient-to-b from-accent to-card text-foreground"><FeatureIcon name={f.icon} /></div>
          <h3 class="text-base font-semibold tracking-tight">{f.title}</h3>
          <p class="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
        </div>
      </li>
    {/each}
  </ul>
</Section>

<Section id="start" title="From clone to queue in four steps" lede="Run the agent yourself, or deploy the complete runtime with Docker. No mini-tui account required.">
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
  <p class="mt-8 text-center text-sm text-muted-foreground">Full guide in the <a class="text-foreground underline underline-offset-4" href={resolve("/docs/install/")}>install docs</a>.</p>
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

<div class="relative overflow-hidden border-t">
  <div class="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(50%_90%_at_50%_100%,color-mix(in_oklab,var(--ring)_20%,transparent),transparent)]" aria-hidden="true"></div>
  <div class="mx-auto max-w-3xl px-4 py-24 text-center sm:px-6">
    <h2 class="text-4xl font-semibold tracking-tight sm:text-5xl">Put work on the queue.</h2>
    <p class="mt-3 text-muted-foreground">Bring your own model. Leave with verified results.</p>
    <div class="mt-8 flex flex-wrap justify-center gap-3">
      <Button size="lg" href={resolve("/docs/install/")} class="rounded-full px-6">Install mini-tui</Button>
      <Button size="lg" variant="outline" href="{REPO}/releases/latest" class="rounded-full px-6">Download v{RELEASE}</Button>
    </div>
    <figure class="mt-12 overflow-hidden rounded-3xl border bg-card shadow-xl shadow-black/20">
      <img src={asset("/og.png")} alt="The mini-tui work queue with eager verification and the final 2.43x worker speedup" width="1200" height="630" fetchpriority="high" class="block h-auto w-full" />
      <figcaption class="sr-only">One chat, a durable work queue and an independent PASS for every task.</figcaption>
    </figure>
  </div>
</div>
