<script lang="ts">
  const calls = [
    { name: "initialize", detail: "session · protocol negotiated", ok: true },
    { name: "tools/list", detail: "Gmail · Sheets · Slack · GitHub", ok: true },
    { name: "tools/call", detail: "SHEETS_BATCH_UPDATE · exact rows", ok: true },
    { name: "task_show_browser", detail: "human login handoff", ok: false },
  ];
</script>

<div class="wrap" aria-hidden="true">
  <div class="browser">
    <div class="tabs"><span class="tab on">Composio MCP</span><span class="tab">Live tab</span></div>
    <div class="page">
      <div class="hero"><i class="l1"></i><i class="l2"></i><i class="l3"></i></div>
      <div class="cards"><i></i><i></i><i></i></div>
      <span class="cursor"></span><span class="ring"></span>
    </div>
  </div>
  <ol class="log">
    {#each calls as call (call.name)}
      <li class={call.ok ? "done" : "wait"}><span class="ic">{call.ok ? "✓" : "○"}</span><div><b>{call.name}</b><small>{call.detail}</small></div></li>
    {/each}
  </ol>
</div>

<style>
  .wrap { display: grid; gap: .8rem; }
  .browser { overflow: hidden; border: 1px solid var(--border); border-radius: 1.1rem; background: var(--card); box-shadow: 0 40px 80px -36px rgb(0 0 0 / .55); }
  .tabs { display: flex; gap: .3rem; padding: .5rem .6rem 0; border-bottom: 1px solid var(--border); background: color-mix(in oklab, var(--background) 60%, var(--card)); }
  .tab { margin-bottom: -1px; padding: .35rem .8rem; border-radius: .6rem .6rem 0 0; color: var(--faint); font-size: .7rem; } .tab.on { border: 1px solid var(--border); border-bottom-color: var(--card); background: var(--card); color: var(--foreground); }
  .page { position: relative; display: grid; gap: 1rem; min-height: 13rem; padding: 1.2rem; }
  .hero { display: grid; gap: .5rem; } .hero i { display: block; height: .7rem; border-radius: 99px; background: var(--accent); } .l1 { width: 62%; height: 1.1rem !important; background: var(--input) !important; opacity: .6; } .l2 { width: 80%; } .l3 { width: 48%; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: .6rem; } .cards i { display: block; height: 4.2rem; border: 1px solid var(--border); border-radius: .8rem; background: var(--secondary); }
  .cursor { position: absolute; width: .9rem; height: .9rem; border-left: 2px solid var(--foreground); border-top: 2px solid var(--foreground); transform: rotate(-20deg); animation: move 7s ease-in-out infinite; }
  .ring { position: absolute; width: 1.8rem; height: 1.8rem; margin: -.45rem 0 0 -.45rem; border: 2px solid var(--ring); border-radius: 50%; opacity: 0; animation: ring 7s ease-in-out infinite; }
  @keyframes move { 0%, 100% { left: 12%; top: 22%; } 40%, 55% { left: 52%; top: 68%; } 80% { left: 78%; top: 40%; } }
  @keyframes ring { 0%, 36% { left: calc(52% - .2rem); top: calc(68% - .2rem); opacity: 0; transform: scale(.4); } 42% { opacity: 1; transform: scale(1); } 58%, 100% { opacity: 0; transform: scale(1.6); left: calc(52% - .2rem); top: calc(68% - .2rem); } }
  .log { display: grid; gap: .4rem; margin: 0; padding: 0; list-style: none; }
  .log li { display: flex; align-items: center; gap: .6rem; padding: .5rem .75rem; border: 1px solid var(--border); border-radius: .8rem; background: var(--card); color: var(--muted-foreground); font-size: .76rem; }
  .log b { display: block; color: var(--foreground); font-family: var(--font-mono); font-size: .7rem; font-weight: 500; } .log small { display: block; margin-top: .1rem; color: var(--faint); font-size: .65rem; }
  .ic { width: 1rem; text-align: center; } .done .ic { color: var(--lime); } .wait { border-color: color-mix(in oklab, var(--amber) 40%, var(--border)); } .wait .ic { color: var(--amber); }
</style>
