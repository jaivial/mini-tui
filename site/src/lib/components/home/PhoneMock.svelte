<script lang="ts">
  // The Release room as a WhatsApp group: the same thread the web app shows, mirrored both ways.
</script>

<div class="phone" aria-hidden="true">
  <div class="notch"></div>
  <header>
    <span class="av">🦊</span>
    <div><b>Release room</b><small>Release bot, Docs bot, you</small></div>
  </header>
  <div class="chat">
    <div class="m me">Ship 0.43 once the reconnect fix is in <i>10:41</i></div>
    <div class="m bot"><u>Release bot</u>On it. 4 cards on the board, 1 already in closure check. <i>10:41</i></div>
    <div class="react">👀</div>
    <div class="m voice me"><span class="play">▶</span><span class="wave"></span><em>0:12</em></div>
    <div class="m bot"><u>Release bot</u>Heard you: also add the install guide. Added as a card for Docs bot. <i>10:43</i></div>
    <div class="m bot"><u>Docs bot</u>Install guide done. Evidence: diff + rendered page. ✅ <i>10:52</i></div>
    <div class="typing"><span></span><span></span><span></span></div>
  </div>
</div>

<style>
  .phone { width: 100%; max-width: 19rem; margin-inline: auto; border-radius: 2.4rem; border: 1px solid var(--input); padding: 0.55rem; background: linear-gradient(160deg, #2b2f38, #101216); box-shadow: 0 50px 80px -30px rgb(0 0 0 / 0.65), 0 0 90px -40px #25d366; position: relative; }
  .notch { position: absolute; top: 0.9rem; left: 50%; width: 4.6rem; height: 1.15rem; border-radius: 99px; background: #05060a; transform: translateX(-50%); z-index: 2; }
  header { display: flex; align-items: center; gap: 0.6rem; padding: 2.6rem 0.9rem 0.7rem; background: #1b2a26; border-radius: 1.9rem 1.9rem 0 0; color: #e8f1ee; }
  header b { display: block; font-size: 0.86rem; } header small { color: #8fa9a1; font-size: 0.68rem; }
  .av { width: 2.1rem; height: 2.1rem; display: grid; place-items: center; border-radius: 99px; background: radial-gradient(circle at 30% 25%, hsl(28 90% 82%), hsl(28 70% 55%)); }
  .chat { display: flex; flex-direction: column; gap: 0.45rem; padding: 0.9rem 0.7rem 1rem; min-height: 21rem; background: #0e1614 radial-gradient(circle at 20% 10%, #15231f, transparent 60%); border-radius: 0 0 1.9rem 1.9rem; font-size: 0.76rem; color: #e8f1ee; }
  .m { position: relative; max-width: 84%; padding: 0.45rem 0.6rem 1rem; border-radius: 0.85rem; line-height: 1.35; }
  .m i { position: absolute; right: 0.5rem; bottom: 0.25rem; font-style: normal; font-size: 0.58rem; opacity: 0.55; }
  .m u { display: block; text-decoration: none; font-weight: 700; font-size: 0.68rem; color: #7ddc8a; margin-bottom: 0.1rem; }
  .me { align-self: flex-end; background: #1f5f4a; border-top-right-radius: 0.25rem; } .bot { align-self: flex-start; background: #1e2724; border-top-left-radius: 0.25rem; }
  .react { align-self: flex-start; margin: -1rem 0 0 0.6rem; background: #1e2724; border: 1px solid #0e1614; border-radius: 99px; padding: 0 0.3rem; font-size: 0.78rem; z-index: 1; }
  .voice { display: flex; align-items: center; gap: 0.5rem; padding-bottom: 0.45rem; } .play { font-size: 0.7rem; } .wave { width: 5.2rem; height: 0.9rem; background: repeating-linear-gradient(90deg, #9fe3c6 0 2px, transparent 2px 5px); mask: linear-gradient(90deg, #000, #000); opacity: 0.8; } .voice em { font-style: normal; font-size: 0.62rem; opacity: 0.7; }
  .typing { align-self: flex-start; display: flex; gap: 0.25rem; padding: 0.5rem 0.65rem; background: #1e2724; border-radius: 0.85rem; } .typing span { width: 0.32rem; height: 0.32rem; border-radius: 99px; background: #8fa9a1; animation: blink 1.2s infinite; } .typing span:nth-child(2) { animation-delay: 0.2s; } .typing span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 50% { opacity: 0.2; transform: translateY(-2px); } }
</style>
