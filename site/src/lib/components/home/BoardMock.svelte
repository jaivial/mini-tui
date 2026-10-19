<script lang="ts">
  // A drawn (not photographed) picture of the web app: bots in the sidebar, a kanban the bot keeps.
  // Everything here is decoration, so the whole figure is hidden from assistive tech.
  const bots = [
    { name: "Release bot", e: "🦊", hue: 28, live: true },
    { name: "Docs bot", e: "🐙", hue: 265, live: true },
    { name: "QA bot", e: "🐼", hue: 160, live: false },
    { name: "Infra bot", e: "🦉", hue: 215, live: false },
  ];
  type Card = { t: string; w: string; live?: boolean; proof?: string; done?: boolean };
  const cols: { id: string; title: string; tone: string; cards: Card[] }[] = [
    { id: "backlog", title: "Backlog", tone: "faint", cards: [
      { t: "Changelog for 0.43", w: "Docs bot" },
      { t: "Rotate the staging keys", w: "Infra bot" },
    ] },
    { id: "doing", title: "Doing", tone: "amber", cards: [
      { t: "Cut release v0.43", w: "Release bot", live: true },
      { t: "Smoke test the landing", w: "QA bot", live: true },
    ] },
    { id: "review", title: "Closure check", tone: "sky", cards: [
      { t: "Fix WhatsApp reconnect", w: "Release bot", proof: "diff + test log" },
    ] },
    { id: "done", title: "Done", tone: "lime", cards: [
      { t: "Group mirror, both ways", w: "Release bot", done: true },
      { t: "Notes panel saves", w: "QA bot", done: true },
      { t: "Install guide", w: "Docs bot", done: true },
    ] },
  ];
</script>

<div class="win" aria-hidden="true">
  <div class="bar">
    <span class="dots"><i></i><i></i><i></i></span>
    <span class="url">mini.local / board</span>
    <span class="pill"><b></b> 3 bots working</span>
  </div>
  <div class="body">
    <aside class="side">
      <p class="cap">Bots</p>
      {#each bots as b (b.name)}
        <div class="bot" class:on={b.live}>
          <span class="av" style="--h:{b.hue}">{b.e}</span>
          <span class="nm">{b.name}</span>
          {#if b.live}<span class="st"></span>{/if}
        </div>
      {/each}
      <p class="cap mt">Groups</p>
      <div class="grp"><span class="wa"></span>Release room</div>
      <div class="grp"><span class="wa"></span>Docs sprint</div>
    </aside>
    <div class="board">
      {#each cols as c (c.id)}
        <section class="col">
          <h4><span class="tone {c.tone}"></span>{c.title}<em>{c.cards.length}</em></h4>
          {#each c.cards as k (k.t)}
            <article class="card" class:live={k.live} class:done={k.done}>
              <p>{k.t}</p>
              <div class="meta">
                <span>{k.w}</span>
                {#if k.proof}<span class="proof">✓ {k.proof}</span>{/if}
                {#if k.done}<span class="ok">✓</span>{/if}
                {#if k.live}<span class="bar2"><i></i></span>{/if}
              </div>
            </article>
          {/each}
        </section>
      {/each}
      <article class="card fly"><p>Ship the landing</p><div class="meta"><span>Docs bot</span></div></article>
    </div>
  </div>
</div>

<style>
  .win { border-radius: 1.25rem; border: 1px solid var(--border); background: linear-gradient(180deg, color-mix(in oklab, var(--card) 92%, white), var(--card)); box-shadow: 0 0 0 1px color-mix(in oklab, var(--foreground) 4%, transparent), 0 40px 90px -30px rgb(0 0 0 / 0.55), 0 0 120px -40px color-mix(in oklab, var(--ring) 40%, transparent); overflow: hidden; text-align: left; font-size: 0.78rem; }
  .bar { display: flex; align-items: center; gap: 0.75rem; padding: 0.65rem 0.9rem; border-bottom: 1px solid var(--border); background: color-mix(in oklab, var(--background) 60%, var(--card)); }
  .dots { display: flex; gap: 0.35rem; } .dots i { width: 0.6rem; height: 0.6rem; border-radius: 99px; background: var(--input); opacity: 0.7; }
  .url { flex: 1; text-align: center; color: var(--faint); font-family: var(--font-mono); font-size: 0.7rem; }
  .pill { display: inline-flex; align-items: center; gap: 0.4rem; border: 1px solid var(--border); border-radius: 99px; padding: 0.15rem 0.6rem; color: var(--muted-foreground); font-size: 0.68rem; }
  .pill b { width: 0.4rem; height: 0.4rem; border-radius: 99px; background: var(--lime); animation: pulse 2s infinite; }
  .body { display: grid; grid-template-columns: 11rem 1fr; min-height: 22rem; }
  .side { border-right: 1px solid var(--border); padding: 0.9rem 0.7rem; background: color-mix(in oklab, var(--background) 40%, var(--card)); }
  .cap { color: var(--faint); font-size: 0.64rem; letter-spacing: 0.12em; text-transform: uppercase; margin: 0 0 0.5rem 0.4rem; } .cap.mt { margin-top: 1.2rem; }
  .bot { display: flex; align-items: center; gap: 0.55rem; padding: 0.4rem 0.45rem; border-radius: 0.8rem; color: var(--muted-foreground); }
  .bot.on { background: var(--accent); color: var(--foreground); }
  .av { display: grid; place-items: center; width: 1.7rem; height: 1.7rem; border-radius: 99px; font-size: 0.95rem; background: radial-gradient(circle at 30% 25%, hsl(var(--h) 90% 82%), hsl(var(--h) 70% 55%)); box-shadow: inset 0 -3px 6px rgb(0 0 0 / 0.18); }
  .nm { flex: 1; font-weight: 500; white-space: nowrap; } .st { width: 0.45rem; height: 0.45rem; border-radius: 99px; background: var(--lime); animation: pulse 2s infinite; }
  .grp { display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0.5rem; color: var(--muted-foreground); } .wa { width: 0.55rem; height: 0.55rem; border-radius: 0.2rem; background: #25d366; opacity: 0.85; }
  .board { position: relative; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.7rem; padding: 0.9rem; }
  .col { display: flex; flex-direction: column; gap: 0.55rem; min-width: 0; }
  h4 { display: flex; align-items: center; gap: 0.4rem; margin: 0 0 0.15rem 0.1rem; font-size: 0.72rem; font-weight: 600; color: var(--muted-foreground); }
  h4 em { margin-left: auto; font-style: normal; color: var(--faint); font-weight: 500; }
  .tone { width: 0.5rem; height: 0.5rem; border-radius: 99px; background: var(--input); } .tone.amber { background: var(--amber); } .tone.sky { background: var(--sky); } .tone.lime { background: var(--lime); }
  .card { border: 1px solid var(--border); background: var(--card); border-radius: 0.85rem; padding: 0.6rem 0.65rem; box-shadow: 0 1px 0 rgb(255 255 255 / 0.04) inset, 0 8px 16px -12px rgb(0 0 0 / 0.5); }
  .card p { margin: 0; font-weight: 500; color: var(--foreground); line-height: 1.3; }
  .card.done p { color: var(--muted-foreground); }
  .card.live { border-color: color-mix(in oklab, var(--amber) 45%, var(--border)); }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; margin-top: 0.45rem; color: var(--faint); font-size: 0.66rem; }
  .proof { color: var(--sky); } .ok { margin-left: auto; color: var(--lime); font-weight: 700; }
  .bar2 { margin-left: auto; width: 2.2rem; height: 0.22rem; border-radius: 9px; background: var(--border); overflow: hidden; } .bar2 i { display: block; height: 100%; width: 40%; background: var(--amber); animation: slide 2.4s ease-in-out infinite; }
  .fly { position: absolute; top: 4.3rem; left: 0.9rem; width: calc((100% - 1.8rem - 2.1rem) / 4); border-color: color-mix(in oklab, var(--ring) 55%, var(--border)); box-shadow: 0 18px 30px -14px color-mix(in oklab, var(--ring) 55%, transparent); animation: fly 9s cubic-bezier(0.6, 0, 0.2, 1) infinite; z-index: 2; }
  @keyframes fly { 0%, 12% { transform: translate(0, 0) rotate(0); } 30%, 46% { transform: translate(calc(100% + 0.7rem), 2.6rem) rotate(-1.5deg); } 62%, 78% { transform: translate(calc(200% + 1.4rem), 5.9rem) rotate(1deg); } 92%, 100% { transform: translate(calc(300% + 2.1rem), 9.8rem) rotate(0); opacity: 0.0; } }
  @keyframes pulse { 50% { opacity: 0.35; } } @keyframes slide { 0%, 100% { transform: translateX(0); } 50% { transform: translateX(150%); } }
  @media (max-width: 760px) { .body { grid-template-columns: 1fr; } .side { display: none; } .board { grid-template-columns: repeat(2, minmax(0, 1fr)); } .fly { display: none; } .url { display: none; } }
</style>
