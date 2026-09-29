<script lang="ts">
  import { Sparkles, CheckCircle2, AlertTriangle, CornerDownLeft } from "@lucide/svelte";
  import type { RunEvent } from "../types";
  import Markdown from "./Markdown.svelte";
  import StepCard from "./StepCard.svelte";
  import Spinner from "./Spinner.svelte";

  let {
    events,
    partial,
    class: klass = "",
  }: { events: RunEvent[]; partial?: { thinking: string; text: string }; class?: string } = $props();

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
    | { kind: "step"; event: RunEvent };

  /** The most recent tool_call, used to pair a result that carries no id. */
  let lastCall: Extract<RunEvent, { type: "tool_call" }> | undefined;

  const rows = $derived.by(() => {
    const out: Row[] = [];
    const byCall = new Map<string, Extract<RunEvent, { type: "tool_call" }>>();
    for (const event of events) {
      if (event.type === "tool_call") {
        if (event.id) byCall.set(event.id, event);
        out.push({ kind: "step", event });
      } else if (event.type === "observation") {
        // Pair a result with the command that produced it, so one row shows
        // `command` + `rc=`. The pair is keyed by tool_call_id, which only the
        // parser's own events carry: the remote mapper sends a null id when the
        // agent streams them separately, so fall back to the previous call.
        const call = (event.toolCallId && byCall.get(event.toolCallId)) ?? lastCall;
        if (call) {
          const idx = out.findIndex((r) => r.kind === "step" && r.event === call);
          if (idx >= 0) {
            out[idx] = {
              kind: "step",
              event: { ...call, returncode: event.returncode, output: event.output, exceptionInfo: event.exceptionInfo } as unknown as RunEvent,
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
</script>

<div class="flex flex-col gap-2 {klass}">
  {#each rows as row, i (i)}
    {#if row.kind === "task"}
      <div class="flex items-start gap-2.5">
        <CornerDownLeft size={14} class="mt-1 shrink-0 text-ink-faint" strokeWidth={1.75} />
        <div class="min-w-0 flex-1">
          <div class="mb-0.5 text-[10px] font-semibold tracking-wider text-ink-faint uppercase">You</div>
          <Markdown text={row.event.text} class="text-[13.5px] text-ink" />
        </div>
      </div>
    {:else if row.kind === "assistant"}
      <div class="flex items-start gap-2.5">
        <Sparkles size={14} class="mt-1 shrink-0 text-brand" strokeWidth={1.75} />
        <div class="min-w-0 flex-1">
          <Markdown text={row.event.text} class="text-[13.5px] text-ink" />
        </div>
      </div>
    {:else if row.kind === "step"}
      <StepCard event={row.event} />
    {:else if row.kind === "thinking"}
      <!--
        A finished thought is a one-line receipt, not a panel: the run's
        timeline stays scannable, and the text is available in <details>.
      -->
      {#if row.event.text}
        <details class="group/think">
          <summary
            class="interactive -mx-1 flex min-h-6 w-56 max-w-full cursor-pointer pointer-coarse:min-h-11 list-none items-center gap-1.5 rounded-sm px-1 text-[11.5px] text-ink-faint hover:bg-raised/60 hover:text-ink-muted"
          >
            <CheckCircle2 size={11} strokeWidth={2} class="shrink-0" />
            <span class="tnum">Thought for {row.event.seconds}s</span>
          </summary>
          <p class="mt-1 border-l border-line/70 py-0.5 pl-3 text-[12.5px] whitespace-pre-wrap text-ink-muted">
            {row.event.text}
          </p>
        </details>
      {:else}
        <div class="flex items-center gap-1.5 px-2.5 text-[11.5px] text-ink-faint">
          <Sparkles size={11} class="shrink-0" strokeWidth={1.75} />
          Thinking…
        </div>
      {/if}
    {:else if row.kind === "notice"}
      <div class="px-2.5 text-[11.5px] text-ink-faint">{row.event.text}</div>
    {:else if row.kind === "exit"}
      {@const okExit = row.event.exitStatus === "Submitted"}
      <div
        class="rounded-lg px-3 py-2 text-[12.5px] {okExit ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn'}"
      >
        <div class="mb-0.5 flex items-center gap-1.5 font-medium">
          <CheckCircle2 size={12} strokeWidth={2} /> {row.event.exitStatus}
        </div>
      </div>
    {:else if row.kind === "error"}
      <div class="flex items-start gap-2 rounded-lg bg-err/10 px-3 py-2 text-[12.5px] text-err">
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
      <div class="rounded-md border border-line/70 bg-surface/60 px-2.5 py-1.5">
        <div class="flex items-center gap-2 text-[11.5px] text-ink-muted">
          <Spinner size={11} label="Thinking" />
          <span aria-hidden="true">Thinking</span><span class="caret" aria-hidden="true"></span>
        </div>
        <div class="mt-1 text-[12.5px] whitespace-pre-wrap text-ink-muted">{partial.thinking}</div>
      </div>
    {/if}
    {#if partial.text}
      <div class="flex items-start gap-2.5">
        <Sparkles size={14} class="mt-1 shrink-0 text-brand" strokeWidth={1.75} />
        <div class="min-w-0 flex-1">
          <Markdown text={partial.text} class="text-[13px] text-ink" />
          <span class="caret" aria-hidden="true"></span>
        </div>
      </div>
    {/if}
  {/if}
</div>
