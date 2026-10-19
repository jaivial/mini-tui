<script lang="ts">
  // A bot driving a real browser through cu, with the steps it reports back to the chat.
  const steps = [
    { s: "done", t: "Open the preview of the landing" },
    { s: "done", t: "Scroll to the pricing table, take a screenshot" },
    { s: "run", t: "Check the layout at 390 px wide" },
    { s: "wait", t: "Post the screenshots to the Release room" },
  ];
</script>

<div class="wrap" aria-hidden="true">
  <div class="br">
    <div class="tabs"><span class="tab on">Landing preview</span><span class="tab">Admin</span></div>
    <div class="page">
      <div class="hero"><i class="l1"></i><i class="l2"></i><i class="l3"></i></div>
      <div class="cards"><i></i><i></i><i></i></div>
      <span class="cursor"></span>
      <span class="ring"></span>
    </div>
  </div>
  <ol class="log">
    {#each steps as s (s.t)}
      <li class={s.s}><span class="ic">{s.s === "done" ? "✓" : s.s === "run" ? "●" : "○"}</span>{s.t}</li>
    {/each}
  </ol>
</div>

<style>
  .wrap { display: grid; gap: 0.8rem; }
  .br { border: 1px solid var(--border); border-radius: 1.1rem; overflow: hidden; background: var(--card); box-shadow: 0 40px 80px -36px rgb(0 0 0 / 0.55); }
  .tabs { display: flex; gap: 0.3rem; padding: 0.5rem 0.6rem 0; background: color-mix(in oklab, var(--background) 60%, var(--card)); border-bottom: 1px solid var(--border); }
  .tab { padding: 0.35rem 0.8rem; border-radius: 0.6rem 0.6rem 0 0; font-size: 0.7rem; color: var(--faint); } .tab.on { background: var(--card); color: var(--foreground); border: 1px solid var(--border); border-bottom-color: var(--card); margin-bottom: -1px; }
  .page { position: relative; padding: 1.2rem; min-height: 13rem; display: grid; gap: 1rem; }
  .hero { display: grid; gap: 0.5rem; } .hero i { display: block; height: 0.7rem; border-radius: 99px; background: var(--accent); } .l1 { width: 62%; height: 1.1rem !important; background: var(--input) !important; opacity: 0.6; } .l2 { width: 80%; } .l3 { width: 48%; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.6rem; } .cards i { display: block; height: 4.2rem; border-radius: 0.8rem; background: var(--secondary); border: 1px solid var(--border); }
  .cursor { position: absolute; width: 0.9rem; height: 0.9rem; border-left: 2px solid var(--foreground); border-top: 2px solid var(--foreground); transform: rotate(-20deg); animation: move 7s ease-in-out infinite; }
  .ring { position: absolute; width: 1.8rem; height: 1.8rem; margin: -0.45rem 0 0 -0.45rem; border-radius: 99px; border: 2px solid var(--ring); opacity: 0; animation: ring 7s ease-in-out infinite; }
  @keyframes move { 0%, 100% { left: 12%; top: 22%; } 40%, 55% { left: 52%; top: 68%; } 80% { left: 78%; top: 40%; } }
  @keyframes ring { 0%, 36% { left: calc(52% - 0.2rem); top: calc(68% - 0.2rem); opacity: 0; transform: scale(0.4); } 42% { opacity: 1; transform: scale(1); } 58%, 100% { opacity: 0; transform: scale(1.6); left: calc(52% - 0.2rem); top: calc(68% - 0.2rem); } }
  .log { display: grid; gap: 0.4rem; margin: 0; padding: 0; list-style: none; }
  .log li { display: flex; gap: 0.6rem; align-items: center; border: 1px solid var(--border); background: var(--card); border-radius: 0.8rem; padding: 0.5rem 0.75rem; font-size: 0.78rem; color: var(--muted-foreground); }
  .ic { width: 1rem; text-align: center; } .done .ic { color: var(--lime); } .run { color: var(--foreground) !important; border-color: color-mix(in oklab, var(--amber) 40%, var(--border)) !important; } .run .ic { color: var(--amber); animation: pulse 1.4s infinite; } .wait { opacity: 0.6; }
  @keyframes pulse { 50% { opacity: 0.3; } }
</style>
