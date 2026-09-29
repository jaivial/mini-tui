<script lang="ts">
  import { ChevronRight, Terminal, CircleCheck, CircleX, TriangleAlert } from "@lucide/svelte";
  import type { RunEvent } from "../types";

  let { event, class: klass = "" }: { event: RunEvent; class?: string } = $props();

  let expanded = $state(false);
  // A row is a command, a result, or both (the transcript pairs them).
  const command = $derived("command" in event ? String(event.command ?? "") : "");
  const output = $derived("output" in event ? String(event.output ?? "") : "");
  const exceptionInfo = $derived("exceptionInfo" in event ? String(event.exceptionInfo ?? "") : "");
  const hasCommand = $derived(command.length > 0);
  const rc = $derived("returncode" in event ? (event.returncode as number | null) : null);
  const ok = $derived(rc === 0);
  // The same three output modes the TUI offers in /settings.
  const lines = $derived(output ? output.split("\n") : []);
  const collapsedBody = $derived(lines.slice(-12).join("\n"));
  const trimmedBody = $derived(lines.slice(0, 2).join("\n"));

  // Pair a call with its observation so one row shows command + result.
  // Chevron rotation is a class, not a directive: directives do not apply to components.
  const chev = $derived(`chev interactive ${expanded ? "rotate-90" : ""}`);
  const label = $derived(hasCommand ? command.split("\n")[0] : "result");
</script>

<div class="overflow-hidden rounded-lg border border-line/80 bg-surface/50 {klass}">
  <!-- header: always a static cue (icon + text), not motion alone -->
  <button
    class="flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left hover:bg-raised/60 pointer-coarse:min-h-11 pointer-coarse:py-3"
    onclick={() => (expanded = !expanded)}
    aria-expanded={expanded}
  >
    <span class="mt-0.5 shrink-0 text-ink-faint">
      <ChevronRight size={14} class={chev} strokeWidth={2} />
    </span>
    {#if hasCommand}
      <Terminal size={14} class="mt-px shrink-0 text-ink-muted" strokeWidth={1.75} />
    {:else if ok}
      <CircleCheck size={14} class="mt-px shrink-0 text-ok" strokeWidth={1.75} />
    {:else}
      <CircleX size={14} class="mt-px shrink-0 text-err" strokeWidth={1.75} />
    {/if}
    <code class="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{label}</code>
    {#if rc !== null}
      <span
        class="tnum shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10px] {ok ? 'bg-ok/12 text-ok' : 'bg-err/12 text-err'}"
      >rc={rc}</span>
    {/if}
  </button>

  <!--
    The body collapses on a 0fr -> 1fr grid track: the intrinsic height is
    animated by the browser, so no measurement and no timer on unmount.
  -->
  <div class="grid transition-[grid-template-rows] duration-[--duration-base] ease-[--ease-standard] {expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}">
    <div class="overflow-hidden">
    <div class="border-t border-line px-3 py-2">
      {#if hasCommand}
        <pre class="overflow-x-auto font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink">{command}</pre>
      {/if}
      {#if output || exceptionInfo}
        {#if exceptionInfo}
          <div class="mb-2 flex items-start gap-1.5 rounded-md bg-err/10 p-2 text-[11.5px] text-err">
            <TriangleAlert size={13} class="mt-px shrink-0" strokeWidth={2} />
            <span class="font-mono break-words">{exceptionInfo}</span>
          </div>
        {/if}
        <pre class="max-h-96 overflow-auto font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-muted">{collapsedBody}</pre>
      {/if}
    </div>
    </div>
  </div>
</div>

<style>
  /* Chevron rotation interpolates instead of jumping; interruptible. */
  .chev {
    transition: transform var(--duration-fast) var(--ease-standard);
  }
</style>
