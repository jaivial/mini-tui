<script lang="ts">
  import Seo from "$lib/components/Seo.svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import BenchmarkBars from "$lib/components/BenchmarkBars.svelte";
  import BenchmarkRounds from "$lib/components/BenchmarkRounds.svelte";
  import BenchmarkAb from "$lib/components/BenchmarkAb.svelte";
  import { AB_TOTAL, REPS } from "$lib/benchmark-data";
  import { oracleBench } from "$lib/content/home";
  import { REPO, RELEASE } from "$lib/site";
</script>

<Seo page={{ path: "/graphics/", title: "Benchmark evidence: eager worker speed", description: "Final mini-tui benchmark graphics: strict MiMo validation, per-task wall times, optimization rounds and the eager worker A/B, with provenance and no historical speedup claims.", modified: "2026-10-25" }} />

<div class="mx-auto max-w-5xl px-4 py-12">
  <p class="eyebrow-page">mini-tui / benchmark evidence / v{RELEASE}</p>
  <h1 class="text-3xl font-semibold tracking-tight">Measured speed. Verifiable quality.</h1>
  <p class="mt-3 max-w-3xl text-muted-foreground">Final runs with the model, endpoint and checker held constant. Local coding corpus, not the inaccessible official Composio suite.</p>
  <div class="mt-8 grid gap-8">
    <Card.Root id="release" class="graphic">
      <Card.Header><p class="eyebrow">mini-tui / v{RELEASE} / final strict run</p><Card.Title class="title">Verified work, at queue speed.</Card.Title><Card.Description class="subtitle">One chat, a durable work queue, and a PASS only when the intact checker says so.</Card.Description></Card.Header>
      <Card.Content class="body">
        <div class="stats lead"><div><b>2.43×</b><span>assigned-worker speedup</span></div><div><b>10/10</b><span>PASS, mini and pi</span></div><div><b>1.84×</b><span>end-to-end speedup</span></div></div>
        <div class="features">
          <div><b>Eager closure</b><p>The first valid PASS closes with a factual card, not another model turn. No post-PASS exploration.</p></div>
          <div><b>Disjoint fan-out</b><p>Independent parts run concurrently only with disjoint directories. Shared-root work uses one worker.</p></div>
          <div><b>Native MCP</b><p>Sessions, JSON/SSE, paginated tools/list and tools/call, off by default for ordinary coding tasks.</p></div>
        </div>
        <p class="note">{oracleBench.caveats}</p>
      </Card.Content><Card.Footer class="footer">Open source · Rust agent · bring your own model · github.com/jaivial/mini-tui</Card.Footer>
    </Card.Root>

    <Card.Root id="progression" class="graphic">
      <Card.Header><p class="eyebrow">mini-tui / optimization path / one line per run</p><Card.Title class="title">From baseline to eager.</Card.Title><Card.Description class="subtitle">Ratio of pi time to mini worker time. Higher is faster for mini; 1.00x is parity.</Card.Description></Card.Header>
      <Card.Content class="body">
        <BenchmarkRounds />
        <p class="note">Eager's three repetitions were {REPS[0].ratio.toFixed(2)}x, {REPS[1].ratio.toFixed(2)}x and {REPS[2].ratio.toFixed(2)}x, each with 20/20 PASS across both arms. The final strict run is shown separately rather than pooled with them.</p>
      </Card.Content><Card.Footer class="footer">Source: runs/queue-20261024-151724, -193813, -211031 and -222316</Card.Footer>
    </Card.Root>

    <Card.Root id="tasks" class="graphic tasks">
      <Card.Header><p class="eyebrow">mini-tui / final strict validation / 24 Oct 2026</p><Card.Title class="title">Every task has its own number.</Card.Title><Card.Description class="subtitle">Wall time in seconds, pi against mini. Same MiMo V2.6 Flash and Singapore endpoint. Lower is faster.</Card.Description></Card.Header>
      <Card.Content class="body">
        <BenchmarkBars />
        <p class="note">Mini was faster on all ten tasks in this run. t6_readme_summary is the narrowest win at 1.48x; t9_pkg_resize is the widest at 3.65x. No historical tasks or earlier ratios are mixed into this chart.</p>
      </Card.Content><Card.Footer class="footer">Source: queue-20261024-222316 · 10/10 PASS on both harnesses</Card.Footer>
    </Card.Root>

    <Card.Root id="eager-ab" class="graphic">
      <Card.Header><p class="eyebrow">mini-tui / worker-only A/B / fast close → eager</p><Card.Title class="title">The saved turn, measured.</Card.Title><Card.Description class="subtitle">Two interleaved repetitions per arm, same binary, model and provider. Arm A: fast close only. Arm C: eager verification.</Card.Description></Card.Header>
      <Card.Content class="body">
        <div class="stats lead"><div><b>{AB_TOTAL.ratio.toFixed(2)}×</b><span>baseline / eager, sum of medians</span></div><div><b>{AB_TOTAL.a.toFixed(1)}s</b><span>arm A, fast close only</span></div><div><b>{AB_TOTAL.c.toFixed(1)}s</b><span>arm C, eager</span></div></div>
        <BenchmarkAb />
        <p class="note">{AB_TOTAL.quality} PASS on each arm. Eager closes when the real checker passes, even if the model used its own tests instead of ./verify.sh. The A/B is a treatment filter, not the final queue comparison.</p>
      </Card.Content><Card.Footer class="footer">Source: worker-ab-20261024-205716 · 20/20 PASS per arm</Card.Footer>
    </Card.Root>
  </div>
  <p class="mt-8 text-muted-foreground">Full methodology and failure history: <a class="underline" href="{REPO}/blob/main/docs/ANALYSIS-mini-x2-20261024.md">docs/ANALYSIS-mini-x2-20261024.md</a>. Composio's published charts remain reference-only until the official 25-task environment is accessible.</p>
</div>

<style>
:global {
  .eyebrow-page { color: var(--faint); font-family: var(--font-mono); font-size: .72rem; letter-spacing: .12em; text-transform: uppercase; }
  .graphic { width: 100%; aspect-ratio: 1; box-sizing: border-box; display: flex; flex-direction: column; gap: 0; --card-spacing: 0px; background: #fff; color: #14161a; border: 1px solid #dcdfe5; border-radius: 28px; padding: 44px; overflow: hidden; font-family: Arial, sans-serif; }
  .graphic [data-slot=card-header], .graphic [data-slot=card-content], .graphic [data-slot=card-footer] { padding: 0; }
  .graphic .eyebrow { margin: 0 0 22px; color: #5d626b; font-size: 15px; letter-spacing: .11em; text-transform: uppercase; }
  .graphic .title { font-size: 44px; line-height: 1.08; letter-spacing: -.045em; font-weight: 600; }
  .graphic .subtitle { margin-top: 16px; color: #4e535c; font-size: 19px; line-height: 1.5; }
  .graphic .body { flex: 1; display: flex; flex-direction: column; padding-top: 28px !important; }
  .graphic .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; border-top: 1px solid #dcdfe5; padding-top: 24px; }
  .graphic .stats b { display: block; font-size: 31px; }
  .graphic .stats span { display: block; margin-top: 6px; color: #4e535c; font-size: 15px; line-height: 1.4; }
  .graphic .stats.lead { margin: 10px 0 26px; border-top: 0; padding-top: 0; }
  .graphic .features { display: grid; gap: 15px; margin-bottom: 24px; }
  .graphic .features b { font-size: 19px; }
  .graphic .features p { margin: 3px 0 0; color: #4e535c; font-size: 15px; line-height: 1.45; }
  .graphic .note { margin-top: auto; padding: 17px; border-radius: 12px; background: #f4f5f7; color: #4e535c; font-size: 15px; line-height: 1.5; }
  .graphic .footer { margin-top: 22px; padding-top: 16px !important; border-top: 1px solid #dcdfe5; color: #5d626b; font-size: 13px; line-height: 1.5; }
  .graphic.tasks .body { padding-top: 22px !important; }
  .graphic.tasks .note { margin-top: 22px; font-size: 14px; }
  @media (max-width: 700px) {
    .graphic { aspect-ratio: auto; min-height: 650px; padding: 24px; }
    .graphic .title { font-size: 31px; }
    .graphic .eyebrow { font-size: 11px; }
    .graphic .subtitle { font-size: 16px; }
    .graphic .stats { gap: 8px; }
    .graphic .stats span { font-size: 12px; }
    .graphic .stats b { font-size: 25px; }
    .graphic .note { margin-top: 28px; }
    .graphic .features b { font-size: 16px; }
    .graphic .features p { font-size: 13px; }
    .graphic .footer { font-size: 11px; }
  }
}
</style>
