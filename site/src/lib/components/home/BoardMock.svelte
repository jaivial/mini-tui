<script lang="ts">
  // Drawn illustration of the current work queue, not the old kanban UI.
  const tasks = [
    { id: "t1", title: "Refactor utils.js", state: "working", note: "worker 1 · editing", tone: "amber" },
    { id: "t2", title: "Analyze 4 logs", state: "working", note: "worker 2 · computing", tone: "amber" },
    { id: "t3", title: "Fix async limiter", state: "done", note: "verify.sh → PASS", tone: "lime" },
    { id: "t4", title: "Reconcile CSV", state: "done", note: "verify.sh → PASS", tone: "lime" },
    { id: "t5", title: "Release v0.45", state: "queued", note: "waiting for a worker", tone: "faint" },
  ];
</script>

<div class="window" aria-hidden="true">
  <div class="topbar">
    <span class="dots"><i></i><i></i><i></i></span>
    <span class="address">mini.local / work-queue</span>
    <span class="live"><b></b> 2 workers running</span>
  </div>
  <div class="layout">
    <section class="chat">
      <p class="eyebrow">One chat</p>
      <div class="message user">Fix the parser and the async limiter, then verify everything.</div>
      <div class="message dispatcher"><span>Dispatcher</span> Created 4 tasks. `allow_overlap: false` passed for the two independent parts.</div>
      <div class="message result"><span>Result card</span> 4/4 checks passed. Closing eager — no final summary turn.</div>
    </section>
    <section class="queue">
      <p class="eyebrow">Work queue</p>
      {#each tasks as task (task.id)}
        <article class="task {task.tone}">
          <div class="line"><strong>{task.id}</strong><span>{task.title}</span><i>{task.state}</i></div>
          <small>{task.note}</small>
        </article>
      {/each}
      <div class="speed"><span>final strict run</span><strong>2.43×</strong><small>worker · 10/10 PASS both</small></div>
    </section>
  </div>
</div>

<style>
  .window { overflow: hidden; border: 1px solid var(--border); border-radius: 1.25rem; background: linear-gradient(180deg, color-mix(in oklab, var(--card) 92%, white), var(--card)); box-shadow: 0 40px 90px -30px rgb(0 0 0 / .55), 0 0 120px -40px color-mix(in oklab, var(--ring) 40%, transparent); text-align: left; font-size: .76rem; }
  .topbar { display: flex; align-items: center; gap: .7rem; padding: .65rem .85rem; border-bottom: 1px solid var(--border); background: color-mix(in oklab, var(--background) 55%, var(--card)); }
  .dots { display: flex; gap: .3rem; } .dots i { width: .55rem; height: .55rem; border-radius: 50%; background: var(--input); }
  .address { flex: 1; color: var(--faint); font-family: var(--font-mono); font-size: .66rem; text-align: center; }
  .live { display: inline-flex; align-items: center; gap: .35rem; color: var(--muted-foreground); font-size: .65rem; } .live b { width: .4rem; height: .4rem; border-radius: 50%; background: var(--lime); }
  .layout { display: grid; grid-template-columns: 1.05fr 1fr; min-height: 23rem; }
  .chat { padding: 1rem; border-right: 1px solid var(--border); background: color-mix(in oklab, var(--background) 35%, var(--card)); }
  .eyebrow { margin: 0 0 .7rem; color: var(--faint); font-size: .62rem; letter-spacing: .12em; text-transform: uppercase; }
  .message { margin-bottom: .65rem; padding: .65rem .7rem; border: 1px solid var(--border); border-radius: .75rem; line-height: 1.45; }
  .message span { display: block; margin-bottom: .2rem; color: var(--faint); font-size: .64rem; text-transform: uppercase; letter-spacing: .06em; }
  .user { background: var(--accent); color: var(--foreground); }
  .dispatcher { color: var(--muted-foreground); }
  .result { border-color: color-mix(in oklab, var(--lime) 35%, var(--border)); color: var(--muted-foreground); }
  .queue { padding: 1rem; }
  .task { margin-bottom: .5rem; padding: .55rem .65rem; border: 1px solid var(--border); border-radius: .7rem; background: var(--card); }
  .line { display: flex; align-items: center; gap: .45rem; }
  .line strong { color: var(--faint); font-family: var(--font-mono); font-weight: 500; }
  .line span { flex: 1; color: var(--foreground); font-weight: 550; }
  .line i { color: var(--faint); font-size: .64rem; font-style: normal; }
  .task small { display: block; margin-top: .2rem; color: var(--faint); font-size: .66rem; }
  .task.lime { border-color: color-mix(in oklab, var(--lime) 30%, var(--border)); }
  .task.lime small { color: var(--lime); }
  .task.amber { border-color: color-mix(in oklab, var(--amber) 35%, var(--border)); }
  .speed { display: grid; grid-template-columns: 1fr auto; align-items: end; gap: .1rem .5rem; margin-top: .8rem; padding: .75rem .65rem; border-radius: .75rem; background: var(--accent); }
  .speed span { color: var(--faint); font-size: .64rem; text-transform: uppercase; letter-spacing: .06em; }
  .speed strong { grid-row: span 2; color: var(--foreground); font-family: var(--font-mono); font-size: 1.65rem; letter-spacing: -.05em; }
  .speed small { color: var(--muted-foreground); font-size: .66rem; }
  @media (max-width: 760px) { .layout { grid-template-columns: 1fr; } .chat { display: none; } .address { display: none; } }
</style>
