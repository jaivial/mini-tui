<script lang="ts">
  import { Brain, ChevronRight, Loader } from "@lucide/svelte";

  let { event }: { event: Extract<import("../types").RunEvent, { type: "thinking" }> } = $props();
  let open = $state(false);
  const running = $derived(!event.text);
  const chev = $derived(`text-ink-faint ${open ? "rotate-90" : ""}`);
</script>

<div class="rounded-md border border-line/70 bg-surface/60">
  <button
    class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left"
    onclick={() => (open = !open)}
    aria-expanded={open}
  >
    <ChevronRight size={12} class={chev} strokeWidth={2} />
    {#if running}
      <Loader size={12} class="animate-spin text-ink-muted" strokeWidth={2} />
      <span class="text-[11.5px] text-ink-muted">Thinking…</span>
    {:else}
      <Brain size={12} class="text-ink-faint" strokeWidth={1.75} />
      <span class="tnum text-[11.5px] text-ink-muted">Thought for {event.seconds}s</span>
    {/if}
  </button>
  {#if open && !running}
    <pre class="border-t border-line/70 px-3 py-2 font-mono read-[11px] leading-relaxed whitespace-pre-wrap text-ink-faint">{event.text}</pre>
  {/if}
</div>
