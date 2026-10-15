<script lang="ts">
  import {
    ChevronRight,
    CircleCheck,
    CircleDashed,
    CircleX,
    Copy,
    Check,
    FileText,
    Globe,
    KanbanSquare,
    Search,
    Terminal,
    Wrench,
  } from "@lucide/svelte";
  import type { RunEvent } from "../types";
  import { arrivalOf, callDuration, callIsRunning, formatDuration } from "../toolTimings";
  import Spinner from "./Spinner.svelte";

  /**
   * One tool call as a compact card (v3.3): an icon for the tool's kind, its
   * name, its state (spinner while it runs, green check when it succeeded,
   * red when it failed), how long it took and a one-line summary of the
   * result. The command (args) and the full output live collapsed inside;
   * a failed call opens itself so the error is never hidden behind a click.
   *
   * The body renders lazily: a chat can hold hundreds of these cards, so the
   * monospace blocks only mount while a card is open (and linger through the
   * closing transition, then unmount).
   */
  let { event, class: klass = "" }: { event: RunEvent; class?: string } = $props();

  // A row is a command, a result, or both (the transcript pairs them).
  const command = $derived("command" in event ? String(event.command ?? "") : "");
  const output = $derived("output" in event ? String(event.output ?? "") : "");
  const exceptionInfo = $derived("exceptionInfo" in event ? String(event.exceptionInfo ?? "") : "");
  const rc = $derived("returncode" in event ? (event.returncode as number | null) : null);
  const name = $derived("name" in event ? String((event as { name?: string }).name ?? "") : "");

  const hasResult = $derived(rc !== null || output !== "" || exceptionInfo !== "");
  const running = $derived(!hasResult && callIsRunning(event));
  const failed = $derived(hasResult && (rc !== null ? rc !== 0 : exceptionInfo !== ""));
  // Measured live (toolTimings) or carried by the transcript's merged row;
  // the merged key can hold undefined, so still fall back to the registry.
  const durationMs = $derived(
    ("durationMs" in event ? (event as { durationMs?: number }).durationMs : undefined) ?? callDuration(event),
  );
  // A call that arrived live but never got its observation (a crash mid-run)
  // still reads as running; one from history with no result is just orphaned.
  const orphaned = $derived(!hasResult && !running && arrivalOf(event) === undefined);

  /** Which inline icon speaks for this tool, from its name. */
  const kind = $derived.by(() => {
    const n = name.toLowerCase();
    if (/(bash|shell|sh\b|exec|terminal|python|node|cmd|command|run)/.test(n)) return "terminal";
    if (/(file|read|write|edit|patch|diff|note)/.test(n)) return "file";
    if (/(search|grep|find|glob|scan|list)/.test(n)) return "search";
    if (/(web|fetch|http|browser|curl|url|download)/.test(n)) return "web";
    if (/(kanban|task|plan|board)/.test(n)) return "board";
    return "generic";
  });
  const ICONS = { terminal: Terminal, file: FileText, search: Search, web: Globe, board: KanbanSquare, generic: Wrench } as const;
  const Icon = $derived(ICONS[kind]);

  const label = $derived(name || (command ? "command" : "result"));
  const summary = $derived.by(() => {
    if (running) return firstLine(command) || "Working…";
    const result = exceptionInfo || firstLine(output);
    return result || firstLine(command) || (rc === null ? "No output" : "");
  });

  function firstLine(text: string) {
    const line = text.split("\n").find((l) => l.trim() !== "");
    return line ? (line.length > 120 ? line.slice(0, 117) + "…" : line) : "";
  }

  // Collapsed by default; a failure opens itself (once — the user can close it again).
  let expanded = $state(false);
  let touched = false;
  $effect(() => {
    if (failed && !touched) expanded = true;
  });

  // Lazy body: mounted on first open, unmounted after the closing transition ends.
  let mounted = $state(false);
  $effect(() => {
    if (expanded) mounted = true;
  });
  function onbodytransitionend(e: TransitionEvent) {
    if (!expanded && e.propertyName === "grid-template-rows") mounted = false;
  }

  // The visible tail of a long output: the whole thing stays in the clipboard copy.
  const TAIL = 200;
  const outputLines = $derived(output ? output.split("\n") : []);
  const shownOutput = $derived(outputLines.length > TAIL ? outputLines.slice(-TAIL).join("\n") : output);
  const hiddenLines = $derived(outputLines.length > TAIL ? outputLines.length - TAIL : 0);

  let copied = $state("");
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = what;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = ""), 1500);
    } catch {
      // Clipboard permission denied: nothing to do, the text is still on screen.
    }
  }

  const chev = $derived(`chev ${expanded ? "rotate-90" : ""}`);
  // The transcript delivers events in batches (the server ingests the
  // trajectory per step), so a client-measured duration only means something
  // when the result demonstrably arrived in a later frame. Below the feed's
  // flush granularity the number would be an artifact, not a fact — no chip.
  const MIN_HONEST_MS = 250;
  const timeLabel = $derived(
    durationMs !== undefined && durationMs >= MIN_HONEST_MS ? formatDuration(durationMs) : "",
  );
</script>

<div
  class="overflow-hidden rounded-2xl border bg-surface/70 transition-[border-color] duration-150 {klass}
    {failed ? 'border-err/30' : 'border-line/80 hover:border-line-strong'}"
>
  <!-- header: icon chip, name, one-line summary, duration, state; the whole card toggles -->
  <button
    type="button"
    class="interactive flex w-full cursor-pointer items-center gap-2 py-2 pr-3 pl-2.5 text-left hover:bg-raised/50 pointer-coarse:min-h-11"
    onclick={() => {
      touched = true;
      expanded = !expanded;
    }}
    aria-expanded={expanded}
  >
    <span
      class="grid size-6 shrink-0 place-items-center rounded-lg {running
        ? 'bg-live-soft text-live'
        : failed
          ? 'bg-err/10 text-err'
          : orphaned
            ? 'bg-raised text-ink-faint'
            : 'bg-ok/10 text-ok'}"
      aria-hidden="true"
    >
      <Icon size={13} strokeWidth={1.75} />
    </span>
    <span class="shrink-0 text-[12px] leading-4 font-semibold tracking-[-0.01em] text-ink">{label}</span>
    <span class="min-w-0 flex-1 truncate font-mono text-[11.5px] leading-4 text-ink-muted" aria-hidden="true">
      {summary}
    </span>
    {#if timeLabel}
      <span class="tnum shrink-0 text-[10.5px] text-ink-faint">{timeLabel}</span>
    {/if}
    <span class="shrink-0">
      {#if running}
        <Spinner size={13} label="Running" />
      {:else if failed}
        <CircleX size={13} strokeWidth={2} class="text-err" aria-label="Failed" />
      {:else if orphaned}
        <CircleDashed size={13} strokeWidth={2} class="text-ink-faint" aria-label="No result" />
      {:else}
        <CircleCheck size={13} strokeWidth={2} class="text-ok" aria-label="OK" />
      {/if}
    </span>
    <ChevronRight size={13} strokeWidth={2} class="{chev} shrink-0 text-ink-faint" aria-hidden="true" />
  </button>

  <!--
    The body collapses on a 0fr -> 1fr grid track (the browser animates the
    intrinsic height, no measurement, no timer) and its content mounts lazily.
  -->
  <div
    class="grid transition-[grid-template-rows] duration-(--duration-base) ease-(--ease-standard) {expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}"
    ontransitionend={onbodytransitionend}
  >
    <div class="overflow-hidden">
      {#if mounted}
        <div class="space-y-2 border-t border-line/70 px-3 py-2">
          {#if command}
            <div>
              <div class="mb-1 flex items-center justify-between gap-2">
                <span class="text-[10px] font-semibold tracking-wider text-ink-faint uppercase">Args</span>
                <button
                  type="button"
                  class="interactive flex cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 text-[10.5px] text-ink-faint hover:bg-raised hover:text-ink pointer-coarse:min-h-11 pointer-coarse:px-2"
                  onclick={() => copy(command, "args")}
                >
                  {#if copied === "args"}<Check size={11} strokeWidth={2} class="text-ok" />{:else}<Copy size={11} strokeWidth={1.75} />{/if}
                  {copied === "args" ? "Copied" : "Copy"}
                </button>
              </div>
              <pre class="max-h-40 overflow-auto rounded-lg bg-raised/70 p-2 font-mono read-[11.5px] leading-relaxed whitespace-pre-wrap text-ink">{command}</pre>
            </div>
          {/if}
          {#if exceptionInfo}
            <div class="flex items-start gap-1.5 rounded-lg bg-err/10 p-2 read-[11.5px] text-err" role="alert">
              <CircleX size={13} class="mt-px shrink-0" strokeWidth={2} aria-hidden="true" />
              <span class="min-w-0 flex-1 font-mono break-words">{exceptionInfo}</span>
            </div>
          {/if}
          {#if output}
            <div>
              <div class="mb-1 flex items-center justify-between gap-2">
                <span class="text-[10px] font-semibold tracking-wider text-ink-faint uppercase">
                  Output{hiddenLines ? ` · last ${TAIL} of ${outputLines.length} lines` : ""}
                </span>
                <button
                  type="button"
                  class="interactive flex cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 text-[10.5px] text-ink-faint hover:bg-raised hover:text-ink pointer-coarse:min-h-11 pointer-coarse:px-2"
                  onclick={() => copy(output, "output")}
                >
                  {#if copied === "output"}<Check size={11} strokeWidth={2} class="text-ok" />{:else}<Copy size={11} strokeWidth={1.75} />{/if}
                  {copied === "output" ? "Copied" : "Copy"}
                </button>
              </div>
              <pre class="max-h-72 overflow-auto rounded-lg bg-raised/70 p-2 font-mono read-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-muted">{shownOutput}</pre>
            </div>
          {/if}
          {#if rc !== null}
            <div class="tnum text-right text-[10px] text-ink-faint">exit {rc}</div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  /* Chevron rotation interpolates instead of jumping; interruptible. */
  .chev {
    transition: transform var(--duration-fast) var(--ease-standard);
  }
</style>
