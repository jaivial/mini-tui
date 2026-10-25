<script lang="ts">
  // Mobile view of the queue and a human browser handoff.
</script>

<div class="phone" aria-hidden="true">
  <div class="notch"></div>
  <header><span class="mark">m</span><div><b>Work queue</b><small>mini-tui · 4 tasks in flight</small></div></header>
  <div class="screen">
    <div class="message user">Check the renewal screen and fix the parser.</div>
    <div class="message agent"><span>Dispatcher</span>Two independent parts are running. The shared-root report stays with one worker.</div>
    <div class="cards">
      <div class="card done"><b>t1 · Parser fix</b><span>verify.sh → PASS</span></div>
      <div class="card working"><b>t2 · Renewal report</b><span>worker running · 6 calls</span></div>
      <div class="card waiting"><b>t3 · Release checks</b><span>queued</span></div>
    </div>
    <div class="handoff"><span class="browser-icon">▣</span><div><b>Login needed</b><p>Open the live tab, scan the QR, then press Done. The worker resumes from here.</p><button>Done</button></div></div>
    <div class="message agent"><span>Worker</span>Verified in the browser and with the checker. Closing with evidence.</div>
  </div>
</div>

<style>
  .phone { position: relative; width: 100%; max-width: 19rem; margin-inline: auto; padding: .55rem; border: 1px solid var(--input); border-radius: 2.4rem; background: linear-gradient(160deg, #2b2f38, #101216); box-shadow: 0 50px 80px -30px rgb(0 0 0 / .65), 0 0 90px -40px color-mix(in oklab, var(--ring) 60%, transparent); }
  .notch { position: absolute; z-index: 2; top: .9rem; left: 50%; width: 4.6rem; height: 1.15rem; border-radius: 99px; background: #05060a; transform: translateX(-50%); }
  header { display: flex; align-items: center; gap: .6rem; padding: 2.6rem .9rem .7rem; border-radius: 1.9rem 1.9rem 0 0; background: #1b2a26; color: #e8f1ee; }
  header b { display: block; font-size: .86rem; } header small { color: #8fa9a1; font-size: .68rem; }
  .mark { display: grid; place-items: center; width: 2.1rem; height: 2.1rem; border-radius: 50%; background: radial-gradient(circle at 30% 25%, hsl(28 90% 82%), hsl(28 70% 55%)); font-size: 1.1rem; font-weight: 700; }
  .screen { display: flex; flex-direction: column; gap: .55rem; min-height: 22rem; padding: .85rem .7rem 1rem; border-radius: 0 0 1.9rem 1.9rem; background: #0e1614 radial-gradient(circle at 20% 10%, #15231f, transparent 60%); color: #e8f1ee; font-size: .74rem; }
  .message { max-width: 92%; padding: .55rem .65rem; border-radius: .75rem; line-height: 1.4; }
  .message span { display: block; margin-bottom: .2rem; color: #7ddc8a; font-size: .62rem; text-transform: uppercase; letter-spacing: .06em; }
  .user { align-self: flex-end; background: #1f5f4a; }
  .agent { align-self: flex-start; background: #1e2724; }
  .cards { display: grid; gap: .4rem; }
  .card { display: grid; gap: .18rem; padding: .5rem .6rem; border: 1px solid #2b3a34; border-radius: .65rem; background: #17201d; }
  .card b { font-weight: 550; } .card span { color: #8fa9a1; font-size: .66rem; }
  .card.done span { color: #7ddc8a; }
  .handoff { display: flex; gap: .55rem; padding: .6rem; border: 1px solid #4b4330; border-radius: .75rem; background: #28251d; }
  .handoff b { font-size: .75rem; } .handoff p { margin: .25rem 0 .45rem; color: #b5b0a4; font-size: .67rem; line-height: 1.4; }
  .handoff button { display: inline-flex; align-items: center; min-height: 44px; border: 1px solid #69715d; border-radius: .45rem; padding: .2rem .7rem; background: #394032; color: #e8f1ee; font-size: .65rem; }
  .browser-icon { display: grid; place-items: center; width: 1.5rem; height: 1.5rem; color: #9fe3c6; font-size: 1.2rem; }
</style>
