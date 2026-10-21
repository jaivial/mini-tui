<script lang="ts">
  import Seo from "$lib/components/Seo.svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import { REPO } from "$lib/site";
  const tasks = [
    ["t1 · word frequency",10.8,7.7],["t2 · grep logs",11.9,7.6],["t3 · Python fix",9.7,7.8],
    ["t4 · refactor",27.7,25.2],["t5 · CSV script",8.6,8.3],["t6 · README summary",14.6,16.0],
    ["t7 · regex CLI",13.1,9.1],["t8 · JavaScript fix",15.4,10.2],["t9 · package resize",13.8,9.1],
    ["t10 · crash report",20.0,11.9]
  ] as const;
  /**
   * One line per measured run. Every ratio keeps its own corpus, model and judge next to it.
   *
   * Colour comes from the documented outcome, never from a numeric threshold: a threshold
   * like "within 0.05 of 1.00x is a tie" would silently reclassify round 3's real 0.95x win
   * as a tie. So `outcome` is set explicitly per run, from what the report states. Round 6 is
   * a documented tie ("median 0.98x, effectively a tie" — docs/pi-vs-mini-benchmark.md §2),
   * so it is neither "faster" (green) nor "slower" (grey); it uses the neutral tie colour and
   * the legend spells the tie out. Round 3 is a documented faster run and stays green at 0.95x.
   */
  type Run = {
    run: string;
    ratio: number;
    label: string;
    note: string;
    outcome: "faster" | "slower" | "tie";
    hollow?: boolean;
    closure?: boolean;
  };
  const runs: readonly Run[] = [
    { run: "Round 1", ratio: 3.65, label: "3.65x", note: "bash-only writes · zai/glm-5.3 · 10 tasks", outcome: "slower" },
    { run: "Round 2", ratio: 1.28, label: "1.28x", note: "native write/edit · minimax/MiniMax-M3", outcome: "slower" },
    { run: "Round 3", ratio: 0.95, label: "0.95x", note: "fast lane + leaner turns", outcome: "faster" },
    { run: "Round 4", ratio: 1.07, label: "1.07x", note: "median flips to mini: 20.0 s vs 21.1 s", outcome: "slower" },
    { run: "Round 5", ratio: 0.69, label: "0.69x", note: "one run · did not reproduce (see round 6)", outcome: "slower", hollow: true },
    { run: "Round 6", ratio: 0.98, label: "0.98x", note: "3 fresh reps: 1.13x, 0.98x, 0.93x — a tie", outcome: "tie" },
    { run: "19 Oct, closure on", ratio: 0.78, label: "0.78x", note: "10 tasks × 3 interleaved reps · 30/30 PASS both arms · MiniMax-M3.1-Flash-Preview + Laya", outcome: "faster", closure: true },
  ];
</script>
<Seo page={{path:"/graphics/",title:"Release graphics and evidence",description:"Source-labelled graphics for mini-tui: the v0.43.0 release card, the run-by-run pi comparison with its provenance, the recovered historical result and the implemented terminal/web parity changes.",modified:"2026-10-21"}} />
<div class="mx-auto max-w-5xl px-4 py-12">
  <h1 class="text-3xl font-semibold">Release graphics and evidence</h1>
  <p class="mt-3 text-muted-foreground">English square graphics, composed from the site's shadcn Card components. Historical results do not measure the current release.</p>
  <div class="mt-8 grid gap-8">
  <Card.Root id="release" class="graphic">
    <Card.Header><p class="eyebrow">mini-tui / new release / v0.43.0</p><Card.Title class="title">Bots that run your board.</Card.Title><Card.Description class="subtitle">You say what you want. The bot writes the cards, workers carry them out, and nothing counts as done until the evidence is on the card.</Card.Description></Card.Header>
    <Card.Content class="body">
      <div class="stats lead"><div><b>30/30</b><span>PASS, both arms, closure check on</span></div><div><b>0.78x</b><span>time vs pi, sum of per-task medians</span></div><div><b>9/10</b><span>tasks where mini was not slower</span></div></div>
      <div class="features">
        <div><b>A board, not a transcript</b><p>Every request becomes cards with dependencies on a durable task graph. Workers lease a card; an expired lease freezes the project instead of dropping work.</p></div>
        <div><b>WhatsApp groups, synced both ways</b><p>Each bot answers in its own group, and the thread mirrors into the web app — voice notes, images and all.</p></div>
        <div><b>A browser it can look through</b><p>The computer-use tool drives real browsers through cu and posts screenshots to the chat, so a bot checks the page it just changed.</p></div>
      </div>
      <p class="note">The 30/30 and 0.78x are the 19 Oct 2026 run: ten tasks, three interleaved repetitions, MiniMax-M3.1-Flash-Preview on both sides, mini with Laya as the judge. Historical readback; not a measurement of the 20 Oct parity changes.</p>
    </Card.Content><Card.Footer class="footer">Open source · Rust agent · bring your own model · github.com/jaivial/mini-tui</Card.Footer>
  </Card.Root>
  <Card.Root id="progression" class="graphic">
    <Card.Header><p class="eyebrow">mini-tui / vs pi / one line per run</p><Card.Title class="title">Every run, with the run it came from.</Card.Title><Card.Description class="subtitle">Wall-clock ratio of mini against pi; below 1.00x is faster for mini. Each bar keeps its corpus, model and judge beside it.</Card.Description></Card.Header>
    <Card.Content class="body">
      <div class="legend"><span class="pi-dot"></span> slower than pi <span class="tie-dot"></span> a tie <span class="mini-dot"></span> faster than pi</div>
      <div class="run-list">{#each runs as r}<div class="run-row{r.closure ? " closure" : ""}"><span>{r.run}</span><div class="run-track"><i class="{r.hollow ? "hollow " : ""}{r.outcome}" style="width:{(r.ratio / 3.7 * 100).toFixed(1)}%"></i><em style="left:{(1 / 3.7 * 100).toFixed(1)}%"></em></div><b>{r.label}</b></div><p class="run-note">{r.note}</p>{/each}</div>
      <p class="note">Rounds 1–6: ten-task corpus, minimax/MiniMax-M3 (round 1: zai/glm-5.3), no closure judge. The 19 Oct line is a different setup — closure check on with Laya — and is not pooled with them. Public leaderboard figures use another corpus and are not plotted here.</p>
    </Card.Content><Card.Footer class="footer">Source: docs/pi-vs-mini-benchmark.md · every ratio keeps its own run</Card.Footer>
  </Card.Root>
  <Card.Root id="historical" class="graphic">
    <Card.Header><p class="eyebrow">mini-tui / historical evidence / 19 Oct 2026</p><Card.Title class="title">A smaller finish line.</Card.Title><Card.Description class="subtitle">Same ten tasks. Same model. Three interleaved repetitions.</Card.Description></Card.Header>
    <Card.Content class="body">
      <div class="metric"><span class="reading">112.9 <small>s</small></span><span class="versus">vs</span><span class="reading">145.6 <small>s</small></span></div>
      <p class="muted">Sum of per-task medians · mini first · lower is better</p>
      <div class="bars">
        <div><b>pi</b><div class="track"><span style="width:100%" class="pi"></span></div><strong>145.6 s</strong></div>
        <div><b>mini + Laya</b><div class="track"><span style="width:77.54%" class="mini"></span></div><strong>112.9 s</strong></div>
      </div>
      <div class="stats"><div><b>30/30</b><span>PASS for each arm</span></div><div><b>9/10</b><span>tasks mini was no slower</span></div><div><b>0.78x</b><span>historical time ratio</span></div></div>
      <p class="note">Recovered completed-run readback. MiniMax-M3.1-Flash-Preview; binary b0537c9; Laya closure on. Temporary raw files are no longer available here. Not a measurement of 20 Oct changes.</p>
    </Card.Content><Card.Footer class="footer">Source: docs/pi-vs-mini-benchmark.md · evidence notes, 20 Oct 2026</Card.Footer>
  </Card.Root>
  <Card.Root id="tasks" class="graphic tasks">
    <Card.Header><p class="eyebrow">mini-tui / historical evidence / 19 Oct 2026</p><Card.Title class="title">Every task has its own story.</Card.Title><Card.Description class="subtitle">Per-task medians in seconds. Same scale, from zero.</Card.Description></Card.Header>
    <Card.Content class="body"><div class="legend"><span class="pi-dot"></span> pi <span class="mini-dot"></span> mini + Laya</div>
      <p class="muted">Bar scale: 0 to 30 seconds · values: pi / mini</p>
      <div class="task-list">{#each tasks as [name,pi,mini]}<div class="task-row"><span>{name}</span><div><i class="pi" style="width:{pi/30*100}%"></i><i class="mini" style="width:{mini/30*100}%"></i></div><b>{pi.toFixed(1)} / {mini.toFixed(1)}</b></div>{/each}</div>
      <p class="note">Three repetitions per task and arm. Mini is slower on README summary. Recovered historical readback; raw files unavailable here. Not a current-release benchmark.</p>
    </Card.Content><Card.Footer class="footer">Source: docs/pi-vs-mini-benchmark.md · ten-task corpus, one model, one host</Card.Footer>
  </Card.Root>
  <Card.Root id="parity" class="graphic">
    <Card.Header><p class="eyebrow">mini-tui / implementation update / 20 Oct 2026</p><Card.Title class="title">One core. Aligned entry points.</Card.Title><Card.Description class="subtitle">Terminal, web and headless use the same session setup.</Card.Description></Card.Header>
    <Card.Content class="body update">
      <div><b>Session context stays together</b><p>Shared environment and recovery metadata; explicit configuration still wins.</p><span>PR #370</span></div>
      <div><b>Streaming does less repeated work</b><p>Headless snapshots append new messages instead of copying the full history on every token.</p><span>PR #373</span></div>
      <div><b>Finished means the process can exit</b><p>The title helper is cancelled after its grace period, rather than keeping the CLI alive.</p><span>PR #374</span></div>
      <p class="note">Code changes, not a measured speedup claim. No new benchmark was run for these changes. Existing terminal sessions were not restarted.</p>
    </Card.Content><Card.Footer class="footer">Sources: GitHub PRs #370, #373, #374 · merged 20 Oct 2026</Card.Footer>
  </Card.Root>
  </div>
  <p class="mt-8 text-muted-foreground"><a href="{REPO}/blob/main/docs/pi-vs-mini-benchmark.md" class="underline">Evidence notes and historical report</a>. The previous 75% composite belongs to another experiment, not these results; round 5's 0.69x is drawn hollow because round 6 did not reproduce it.</p>
</div>
<style>
:global {

.graphic{width:100%;aspect-ratio:1;box-sizing:border-box;display:flex;flex-direction:column;gap:0;--card-spacing:0px;background:#fff;color:#14161a;border:1px solid #dcdfe5;border-radius:28px;padding:44px;overflow:hidden;font-family:Arial,sans-serif}
.graphic [data-slot=card-header],.graphic [data-slot=card-content],.graphic [data-slot=card-footer]{padding:0}
.graphic .eyebrow{font-size:15px;letter-spacing:.11em;text-transform:uppercase;color:#5d626b;margin:0 0 22px}
.graphic .title{font-size:44px;line-height:1.08;letter-spacing:-.045em;font-weight:600}
.graphic .subtitle{font-size:19px;line-height:1.5;margin-top:16px;color:#4e535c}
.graphic .body{flex:1;display:flex;flex-direction:column;padding-top:28px!important}
.graphic .metric{display:flex;align-items:baseline;gap:24px;font-size:64px;line-height:1;letter-spacing:-.055em;margin:8px 0 15px}
.graphic .metric .reading{font-size:inherit;white-space:nowrap}.graphic .metric small{font-size:.34em;letter-spacing:0}.graphic .metric .versus{align-self:center;font-size:23px;color:#5d626b;letter-spacing:0}
.graphic .muted{font-size:16px;color:#4e535c}
.graphic .bars{display:grid;gap:18px;margin:32px 0}
.graphic .bars>div{display:grid;grid-template-columns:110px 1fr 86px;gap:14px;align-items:center;font-size:16px}
.graphic .track{height:23px;background:#e9ebef;border-radius:4px}
.graphic .track span{display:block;height:100%;border-radius:4px}
.graphic .pi{background:#626975}
.graphic .mini{background:#2f9e55}
.graphic .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;border-top:1px solid #dcdfe5;padding-top:24px}
.graphic .stats b{display:block;font-size:31px}
.graphic .stats span{display:block;font-size:15px;color:#4e535c;line-height:1.4;margin-top:6px}
.graphic .note{font-size:15px;line-height:1.5;color:#4e535c;background:#f4f5f7;padding:17px;border-radius:12px;margin-top:auto}
.graphic .stats.lead{border-top:0;padding-top:0;margin:10px 0 26px}
.graphic .features{display:grid;gap:15px;margin-bottom:24px}
.graphic .features b{font-size:19px}
.graphic .features p{font-size:15px;color:#4e535c;line-height:1.45;margin:3px 0 0}
.graphic .run-list{display:grid;grid-template-columns:1fr;gap:4px;margin:6px 0 20px}
.graphic .run-row{display:grid;grid-template-columns:150px 1fr 62px;gap:12px;align-items:center;font-size:14px}
.graphic .run-row.closure{font-weight:600}
.graphic .run-track{position:relative;height:11px;background:#eef0f3;border-radius:3px}
.graphic .run-track i{display:block;height:100%;border-radius:3px}
.graphic .run-track i.faster{background:#2f9e55}
.graphic .run-track i.slower{background:#626975}
/* Documented tie: neither mini's green nor pi's grey — a neutral slate so it is not read as a win. */
.graphic .run-track i.tie{background:#8a8f98}
.graphic .run-track i.hollow{background:#fff;border:2px solid #626975}
.graphic .run-track em{position:absolute;top:-3px;bottom:-3px;width:1px;background:#14161a}
.graphic .run-row b{text-align:right;font-size:14px}
.graphic .run-note{grid-column:1/-1;font-size:12.5px;color:#5d626b;margin:0 0 8px 162px}
.graphic .footer{font-size:13px;line-height:1.5;color:#5d626b;border-top:1px solid #dcdfe5;padding-top:16px!important;margin-top:22px}
.graphic .legend{font-size:15px;display:flex;gap:9px;align-items:center;margin-bottom:17px}
.graphic .pi-dot,.graphic .mini-dot{display:inline-block;width:10px;height:10px;border-radius:3px;background:#626975}
.graphic .tie-dot{display:inline-block;width:10px;height:10px;border-radius:3px;background:#8a8f98;margin-left:14px}
.graphic .mini-dot{background:#2f9e55;margin-left:14px}
.graphic .task-list{display:grid;gap:12px}
.graphic .task-row{display:grid;grid-template-columns:186px 1fr 95px;gap:10px;align-items:center;font-size:14px}
.graphic .task-row>div{display:grid;gap:4px;background:repeating-linear-gradient(90deg,#fff 0,#fff calc(33.33% - 1px),#e9ebef calc(33.33% - 1px),#e9ebef 33.33%)}
.graphic .task-row i{height:8px;border-radius:2px}
.graphic .task-row b{font-size:13px;font-weight:400;text-align:right}
.graphic.tasks .body{padding-top:22px!important}
.graphic.tasks .note{font-size:14px;margin-top:22px}
.graphic .update{gap:22px}
.graphic .update>div{position:relative;padding-right:65px}
.graphic .update b{font-size:24px}
.graphic .update p:not.note{font-size:17px;color:#4e535c;line-height:1.5;margin:8px 0 0}
.graphic .update span{position:absolute;right:0;top:6px;font-size:13px;color:#5d626b}
.graphic .update .note{margin-top:auto}
@media(max-width:700px){
.graphic{aspect-ratio:auto;min-height:650px;padding:24px}
.graphic .title{font-size:31px}
.graphic .metric{font-size:38px;gap:12px}
.graphic .metric .versus{font-size:18px}
.graphic .eyebrow{font-size:11px}
.graphic .subtitle{font-size:16px}
.graphic .stats{gap:8px}
.graphic .stats span{font-size:12px}
.graphic .stats b{font-size:25px}
.graphic .bars>div{grid-template-columns:80px 1fr 60px;font-size:12px;gap:8px}
.graphic .task-row{grid-template-columns:112px 1fr 73px;font-size:10px;gap:5px}
.graphic .task-row b{font-size:10px}
.graphic .note{margin-top:28px}
.graphic .update b{font-size:19px}
.graphic .update p:not.note{font-size:15px}
.graphic .run-row{grid-template-columns:104px 1fr 46px;font-size:11px;gap:7px}
.graphic .run-note{font-size:10.5px;margin:0 0 7px 111px}
.graphic .run-track{height:9px}
.graphic .features b{font-size:16px}
.graphic .features p{font-size:13px}
.graphic .footer{font-size:11px}}

}
</style>
