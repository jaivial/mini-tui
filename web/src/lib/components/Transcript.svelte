<script lang="ts">
  import { Check, CheckCircle2, AlertTriangle, Copy, Sparkles } from "@lucide/svelte";
  import type { RunEvent } from "../types";
  import Markdown from "./Markdown.svelte";
  import StepCard from "./StepCard.svelte";
  import Spinner from "./Spinner.svelte";
  import { arrivalOf, callDuration } from "../toolTimings";
  import UiComponent from "./ui/UiComponent.svelte";

  let {
    events,
    partial,
    onsubmit,
    class: klass = "",
  }: { events: RunEvent[]; partial?: { thinking: string; text: string }; onsubmit?: (message: string) => void; class?: string } = $props();

  // Pair each tool_call with its observation (by toolCallId) so a command and
  // its result render as one row, the way the TUI does.
  // Each row keeps the narrowed event type, so the template needs no casts.
  type Row =
    | { kind: "task"; event: Extract<RunEvent, { type: "task" }> }
    | { kind: "assistant"; event: Extract<RunEvent, { type: "assistant" }> }
    | { kind: "notice"; event: Extract<RunEvent, { type: "notice" }> }
    | { kind: "exit"; event: Extract<RunEvent, { type: "exit" }> }
    | { kind: "error"; event: Extract<RunEvent, { type: "error" }> }
    | { kind: "thinking"; event: Extract<RunEvent, { type: "thinking" }> }
    | { kind: "ui-component"; event: Extract<RunEvent, { type: "ui-component" }> }
    | { kind: "step"; event: RunEvent };

  /** The most recent tool_call, used to pair a result that carries no id. */
  let lastCall: Extract<RunEvent, { type: "tool_call" }> | undefined;
  /** Its index in `out`, so pairing is O(1) instead of a scan per observation. */
  let lastCallIdx = -1;

  const rows = $derived.by(() => {
    const out: Row[] = [];
    const byCall = new Map<string, Extract<RunEvent, { type: "tool_call" }>>();
    for (const event of events) {
      if (event.type === "tool_call") {
        if (event.id) byCall.set(event.id, event);
        lastCallIdx = out.length;
        out.push({ kind: "step", event });
      } else if (event.type === "observation") {
        // Pair a result with the command that produced it, so one row shows
        // `command` + `rc=`. The pair is keyed by tool_call_id, which only the
        // parser's own events carry: the remote mapper sends a null id when the
        // agent streams them separately, so fall back to the previous call.
        const call = (event.toolCallId && byCall.get(event.toolCallId)) ?? lastCall;
        if (call) {
          // The common case is the call just pushed; anything else (an older
          // id-matched call) pays the scan, as before.
          let idx = -1;
          if (lastCallIdx >= 0 && out[lastCallIdx]?.kind === "step" && out[lastCallIdx]!.event === call) idx = lastCallIdx;
          else idx = out.findIndex((r) => r.kind === "step" && r.event === call);
          if (idx >= 0) {
            // The merged row carries the call's measured duration, taken before
            // the derived pass recreates the object (weak keys die with it).
            out[idx] = {
              kind: "step",
              event: {
                ...call,
                returncode: event.returncode,
                output: event.output,
                exceptionInfo: event.exceptionInfo,
                durationMs: callDuration(call),
              } as unknown as RunEvent,
            };
            continue;
          }
        }
        out.push({ kind: "step", event });
      } else {
        out.push({ kind: event.type, event } as Row);
      }
      lastCall = event.type === "tool_call" ? (event as Extract<RunEvent, { type: "tool_call" }>) : lastCall;
    }
    return out;
  });

  /**
   * Consecutive messages of the same author group together (the chat-app
   * rule): the first of a run keeps the full gap and a quiet timestamp, the
   * rest tuck close under it. Anything else (a tool card, a notice) breaks
   * the run.
   */
  const GAP = "mt-3.5 pane-sm:mt-3";
  const TUCK = "mt-1";

  function grouped(prev: Row | undefined, row: Row) {
    return prev !== undefined && prev.kind === row.kind && (row.kind === "assistant" || row.kind === "task");
  }

  function clock(event: object) {
    const at = arrivalOf(event);
    if (at === undefined) return "";
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  /**
   * Copy action on a turn, revealed on hover/focus-within (pointer devices) and
   * always visible on touch — the Control-UI chat pattern: actions live on the
   * row, never inside the text flow, and a copied state confirms the click.
   */
  let copiedId: string | null = null;
  async function copyTurn(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      copiedId = key;
      setTimeout(() => {
        if (copiedId === key) copiedId = null;
      }, 1500);
    } catch {
      // a denied clipboard is silent: the button simply does nothing
    }
  }
</script>

<div class="flex flex-col {klass}">
  {#each rows as row, i (i)}
    {@const prev = rows[i - 1]}
    {@const isGrouped = grouped(prev, row)}
    {@const gap = i === 0 ? "" : isGrouped ? TUCK : GAP}
    {#if row.kind === "task"}
      <!-- The user speaks in the near-black bubble, at the right (the mockup's). -->
      <div class="turn group/turn flex flex-col items-end {gap}">
        {#if !isGrouped}
          {@const at = clock(row.event)}
          {#if at}<div class="tnum pointer-coarse:px-1 pr-1 text-[10px] leading-3 text-ink-faint">{at}</div>{/if}
        {/if}
        <div class="flex items-end gap-1">
          <div class="msg-user max-w-[85%] rounded-2xl rounded-br-md bg-bubble-user px-3.5 py-2 pointer-coarse:px-4">
            <Markdown text={row.event.text} class="read-[14px] leading-[1.55] text-bubble-user-ink" />
          </div>
          <button
            type="button"
            class="turn-action"
            aria-label="Copiar mensaje"
            onclick={() => copyTurn(row.event.text, `t${i}`)}
          >
            {#if copiedId === `t${i}`}
              <Check size={12} strokeWidth={2} aria-hidden="true" />
            {:else}
              <Copy size={12} strokeWidth={1.75} aria-hidden="true" />
            {/if}
          </button>
        </div>
      </div>
    {:else if row.kind === "assistant"}
      <!-- The bot answers in the soft grey bubble, at the left. -->
      <div class="turn group/turn flex flex-col items-start {gap}">
        {#if !isGrouped}
          {@const at = clock(row.event)}
          {#if at}<div class="tnum pointer-coarse:px-1 pl-1 text-[10px] leading-3 text-ink-faint">{at}</div>{/if}
        {/if}
        <div class="flex items-end gap-1">
          <div class="max-w-[85%] rounded-2xl rounded-bl-md bg-bubble-bot px-3.5 py-2 pointer-coarse:px-4">
            <Markdown text={row.event.text} class="read-[14px] leading-[1.55] text-ink" />
          </div>
          <button
            type="button"
            class="turn-action"
            aria-label="Copiar respuesta"
            onclick={() => copyTurn(row.event.text, `a${i}`)}
          >
            {#if copiedId === `a${i}`}
              <Check size={12} strokeWidth={2} aria-hidden="true" />
            {:else}
              <Copy size={12} strokeWidth={1.75} aria-hidden="true" />
            {/if}
          </button>
        </div>
      </div>
    {:else if row.kind === "step"}
      <div class={gap}><StepCard event={row.event} /></div>
    {:else if row.kind === "ui-component"}
      <!-- Generative UI: a component of the closed set, validated before render. -->
      <div class="{gap} pl-1">
        <UiComponent template={row.event.template} props={row.event.props} {onsubmit} />
      </div>
    {:else if row.kind === "thinking"}
      <!--
        A finished thought is a one-line receipt, not a panel: the run's
        timeline stays scannable, and the text is available in <details>.
      -->
      {#if row.event.text}
        <details class="group/think {gap}">
          <summary
            class="interactive -mx-1 flex min-h-6 w-56 max-w-full cursor-pointer pointer-coarse:min-h-11 list-none items-center gap-1.5 rounded-sm px-1 text-[11.5px] text-ink-faint hover:bg-raised/60 hover:text-ink-muted"
          >
            <CheckCircle2 size={11} strokeWidth={2} class="shrink-0" />
            <span class="tnum">Thought for {row.event.seconds}s</span>
          </summary>
          <p class="mt-1 border-l border-line/70 py-0.5 pl-3 read-[12.5px] whitespace-pre-wrap text-ink-muted">
            {row.event.text}
          </p>
        </details>
      {:else}
        <div class="flex items-center gap-1.5 px-2.5 text-[11.5px] text-ink-faint {gap}">
          <Sparkles size={11} class="shrink-0" strokeWidth={1.75} />
          Thinking…
        </div>
      {/if}
    {:else if row.kind === "notice"}
      <div class="px-2.5 read-[11.5px] text-ink-faint {gap}">{row.event.text}</div>
    {:else if row.kind === "exit"}
      {@const okExit = row.event.exitStatus === "Submitted"}
      <div class="{gap} rounded-2xl px-3 py-2 read-[12.5px] {okExit ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'}">
        <div class="mb-0.5 flex items-center gap-1.5 font-medium">
          <CheckCircle2 size={12} strokeWidth={2} /> {row.event.exitStatus}
        </div>
      </div>
    {:else if row.kind === "error"}
      <div class="flex items-start gap-2 rounded-2xl bg-err/10 px-3 py-2 read-[12.5px] text-err {gap}">
        <AlertTriangle size={14} class="mt-px shrink-0" strokeWidth={2} />
        <pre class="font-mono break-words whitespace-pre-wrap">{row.event.text}</pre>
      </div>
    {/if}
  {/each}

  <!--
    The message being generated right now. Its content is not an event yet, so it is
    rendered here rather than in the rows above: the real events replace it the moment the
    model finishes. The caret is the only feedback that this text is still moving.
  -->
  {#if partial && (partial.text || partial.thinking)}
    {#if partial.thinking}
      <div class="mt-3.5 rounded-2xl border border-line/70 bg-surface/60 px-2.5 py-1.5">
        <div class="flex items-center gap-2 text-[11.5px] text-ink-muted">
          <Spinner size={11} label="Thinking" />
          <span aria-hidden="true">Thinking</span><span class="caret" aria-hidden="true"></span>
        </div>
        <div class="mt-1 read-[12.5px] whitespace-pre-wrap text-ink-muted">{partial.thinking}</div>
      </div>
    {/if}
    {#if partial.text}
      <div class="mt-3.5 flex justify-start">
        <div class="max-w-[85%] rounded-2xl rounded-bl-md bg-bubble-bot px-3.5 py-2 pointer-coarse:px-4">
          <Markdown text={partial.text} class="read-[14px] leading-[1.55] text-ink" />
          <span class="caret" aria-hidden="true"></span>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  /*
   * Turn hover action (Control-UI chat pattern): the row's copy affordance lives
   * beside the bubble, invisible until the row is hovered or focused with a
   * pointer; on touch it is always visible at a quiet opacity (no hover to
   * reveal it) and meets the 44px target. Colors come from the theme tokens, so
   * light and dark both read.
   */
  .turn-action {
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    margin-bottom: 2px;
    border-radius: var(--radius-sm, 6px);
    color: var(--color-ink-faint);
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--duration-fast, 120ms) var(--ease-standard, ease);
  }
  .turn:hover .turn-action,
  .turn:focus-within .turn-action {
    opacity: 1;
    pointer-events: auto;
  }
  .turn-action:hover {
    background: var(--color-raised);
    color: var(--color-ink);
  }
  @media (pointer: coarse) {
    .turn-action {
      opacity: 1;
      pointer-events: auto;
      width: 2.75rem;
      height: 2.75rem;
    }
  }

  /* Inside the near-black bubble the palette flips: links go light blue,
     strong text to the bubble's own ink, code to a translucent chip — the
     prose-mini defaults assume a page-coloured surface and would vanish. */
  .msg-user :global(.prose-mini a) {
    color: #9dc0ff;
  }
  .msg-user :global(.prose-mini strong) {
    color: var(--color-bubble-user-ink);
  }
  .msg-user :global(.prose-mini code) {
    background: rgb(255 255 255 / 0.14);
  }
  .msg-user :global(.prose-mini pre) {
    background: rgb(255 255 255 / 0.08);
    border-color: rgb(255 255 255 / 0.16);
  }
  .msg-user :global(.prose-mini blockquote) {
    color: rgb(245 245 248 / 0.75);
  }
</style>
