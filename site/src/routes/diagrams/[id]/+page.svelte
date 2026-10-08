<script lang="ts">
  import { resolve } from "$app/paths";
  import Seo from "$lib/components/Seo.svelte";
  import { compartments, fieldText } from "$lib/diagram";

  let { data } = $props();
  const d = $derived(data.diagram);
  const laid = $derived(data.laid);
  // One quiet accent per kind, as in the mental-diagram site.
  const hue: Record<string, string> = {
    entry: "oklch(0.62 0.13 250)", service: "oklch(0.62 0.12 190)", function: "oklch(0.6 0.03 260)",
    data: "oklch(0.62 0.12 150)", external: "oklch(0.68 0.13 75)", decision: "oklch(0.62 0.15 10)",
    config: "oklch(0.6 0.02 260)", queue: "oklch(0.64 0.14 40)", ui: "oklch(0.62 0.12 300)",
  };
  const accent = (k?: string) => hue[k ?? "function"] ?? hue.function;
</script>

<Seo
  page={{
    path: `/diagrams/${d.id}/`,
    title: `${d.title} diagram`,
    description: d.question ?? d.summary ?? d.title,
    type: "article",
    modified: (d.updatedAt ?? "2026-10-08").slice(0, 10),
    crumbs: [{ name: "Home", path: "/" }, { name: "Docs", path: "/docs/" }, { name: d.title, path: `/diagrams/${d.id}/` }],
  }}
/>

<div class="mx-auto max-w-7xl 2xl:max-w-[90rem] px-4 py-12 sm:px-6">
  <nav aria-label="Breadcrumb" class="mb-4 text-sm text-muted-foreground">
    <ol class="flex flex-wrap items-center gap-1.5">
      <li><a class="hover:text-foreground" href={resolve("/")}>Home</a></li>
      <li aria-hidden="true">/</li>
      <li><a class="hover:text-foreground" href={resolve("/docs/")}>Docs</a></li>
      <li aria-hidden="true">/</li>
      <li aria-current="page" class="text-foreground">{d.title}</li>
    </ol>
  </nav>
  <h1 class="text-4xl font-semibold tracking-tight">{d.title}</h1>
  {#if d.project}<p class="mt-2 text-sm text-faint">{d.project}</p>{/if}
  {#if d.question}<p class="mt-4 max-w-3xl text-lg text-muted-foreground">{d.question}</p>{/if}
  {#if d.summary}<p class="mt-3 max-w-3xl leading-relaxed">{d.summary}</p>{/if}
  <p class="mt-3 text-xs text-faint">
    Every box is a real piece of the code, drawn like a UML class: «stereotype» and name, then <span class="font-mono">−</span> attributes,
    <span class="font-mono">+</span> operations, <span class="font-mono">–</span> responsibilities. Click a box for its details and the steps it follows.
    Dashed arrows go back up the flow (retries and loops).
  </p>

  <figure class="mt-8 overflow-x-auto rounded-lg border bg-card/40 p-2" aria-label="Diagram: {d.title}">
    <div class="relative mx-auto" style:width="{laid.width}px" style:height="{laid.height}px">
      <svg class="absolute inset-0" width={laid.width} height={laid.height} aria-hidden="true">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--faint)" />
          </marker>
        </defs>
        {#each laid.edges as e, i (i)}
          <path d={e.path} fill="none" stroke="var(--faint)" stroke-width="1.25" stroke-dasharray={e.back ? "5 4" : undefined} marker-end="url(#arrow)" />
        {/each}
      </svg>
      {#each laid.edges as e, i (i)}
        {#if e.label}
          <span
            class="absolute -translate-x-1/2 -translate-y-1/2 rounded bg-background px-1 font-mono text-[10.5px] whitespace-nowrap text-muted-foreground"
            style:left="{e.lx}px"
            style:top="{e.ly}px">{e.label}</span
          >
        {/if}
      {/each}
      {#each laid.nodes as b (b.node.id)}
        <a
          href="#{b.node.id}"
          class="uml absolute flex flex-col overflow-hidden rounded-md border border-l-[3px] bg-card text-card-foreground no-underline shadow-sm transition-colors hover:border-ring"
          style:left="{b.x}px"
          style:top="{b.y}px"
          style:width="{b.width}px"
          style:height="{b.height}px"
          style:border-left-color={accent(b.node.kind)}
        >
          <span class="flex flex-col items-center justify-center px-3 text-center" style:height={b.node.summary ? "72px" : "54px"}>
            <span class="text-[10.5px] tracking-wide" style:color={accent(b.node.kind)}>«{b.node.stereotype ?? b.node.kind ?? "component"}»</span>
            <span class="text-sm font-semibold leading-tight">{b.node.label}</span>
            {#if b.node.summary}<span class="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{b.node.summary}</span>{/if}
          </span>
          {#each compartments(b.node) as c (c.key)}
            <span class="block border-t px-3 py-1.5">
              {#each c.lines as line, j (j)}
                <span class="block font-mono text-[11.5px] leading-[17px] break-words {c.key === 'responsibilities' ? 'text-muted-foreground' : ''}">{c.mark} {line}</span>
              {/each}
            </span>
          {/each}
        </a>
      {/each}
    </div>
  </figure>
  {#if d.source}<p class="mt-2 text-xs text-faint">Source: {d.source}</p>{/if}

  <section class="mt-14" aria-labelledby="nodes">
    <h2 id="nodes" class="text-2xl font-semibold tracking-tight">Node by node</h2>
    <div class="mt-6 grid gap-5 lg:grid-cols-2">
      {#each d.nodes as n (n.id)}
        <article id={n.id} class="scroll-mt-24 rounded-lg border border-l-[3px] p-5" style:border-left-color={accent(n.kind)}>
          <p class="text-xs" style:color={accent(n.kind)}>«{n.stereotype ?? n.kind}»</p>
          <h3 class="text-lg font-semibold">{n.label}</h3>
          {#if n.file}<p class="font-mono text-xs break-all text-faint">{n.file}</p>{/if}
          {#if n.summary}<p class="mt-1 text-sm text-muted-foreground">{n.summary}</p>{/if}
          {#each [["Attributes", n.attributes], ["Operations", n.operations], ["Input", n.input], ["Output", n.output]] as const as [title, fields] (title)}
            {#if fields?.length}
              <h4 class="mt-4 text-xs font-semibold tracking-wide text-faint uppercase">{title}</h4>
              <ul class="mt-1.5 space-y-1 text-sm">
                {#each fields as f, j (j)}
                  <li><code class="font-mono text-[0.85em]">{fieldText(f)}</code>{#if f.description}<span class="text-muted-foreground"> — {f.description}</span>{/if}</li>
                {/each}
              </ul>
            {/if}
          {/each}
          {#if n.responsibilities?.length}
            <h4 class="mt-4 text-xs font-semibold tracking-wide text-faint uppercase">Responsibilities</h4>
            <ul class="mt-1.5 list-disc space-y-1 pl-5 text-sm">{#each n.responsibilities as r, j (j)}<li>{r}</li>{/each}</ul>
          {/if}
          {#if n.process?.length}
            <h4 class="mt-4 text-xs font-semibold tracking-wide text-faint uppercase">What it does inside</h4>
            <ol class="mt-1.5 list-decimal space-y-1 pl-5 text-sm leading-relaxed">{#each n.process as s, j (j)}<li>{s}</li>{/each}</ol>
          {/if}
          {#if n.notes}<p class="mt-3 text-sm text-muted-foreground">{n.notes}</p>{/if}
        </article>
      {/each}
    </div>
  </section>
</div>
