<script lang="ts">
  import { fusion } from "$lib/content/home";
</script>

<ol class="mx-auto grid max-w-3xl gap-3" aria-label="One Fusion conversation, step by step">
  {#each fusion as s (s.id)}
    <li class="grid gap-3 rounded-3xl border bg-card p-5 sm:grid-cols-[2.5rem_minmax(0,1fr)] sm:p-6 {s.lane === 'worker' ? 'md:ml-12' : 'md:mr-12'}">
      <span class="grid size-9 place-items-center rounded-full border font-mono text-sm text-muted-foreground" aria-hidden="true">{s.id}</span>
      <div class="min-w-0">
        <p class="inline-flex items-center gap-2 rounded-full border px-2.5 py-0.5 font-mono text-xs {s.lane === 'worker' ? 'bg-accent/60 text-foreground' : 'text-muted-foreground'}">
          <span class="size-1.5 rounded-full {s.lane === 'worker' ? 'bg-[var(--lime)]' : 'bg-[var(--ring)]'}" aria-hidden="true"></span>{s.who}
        </p>
        <h3 class="mt-3 text-lg font-semibold tracking-tight">{s.title}</h3>
        <p class="mt-1 text-sm text-muted-foreground">{s.body}</p>
        {#if s.call}
          <code class="mt-3 block max-w-full overflow-x-auto rounded-xl border bg-background/60 px-3 py-2 font-mono text-xs whitespace-nowrap">{s.call}</code>
        {/if}
      </div>
    </li>
  {/each}
</ol>
<p class="mx-auto mt-6 max-w-3xl text-center text-sm text-muted-foreground">Strict mode refuses any bash, write or edit from the main model. Same conversation, full history, no subagents.</p>
