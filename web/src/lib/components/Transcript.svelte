<script lang="ts">
  import { tick } from "svelte";
  import { Check, CheckCircle2, AlertTriangle, Copy, Sparkles, MessageCircle } from "@lucide/svelte";
  import type { RunEvent } from "../types";
  import Markdown from "./Markdown.svelte";
  import StepCard from "./StepCard.svelte";
  import Spinner from "./Spinner.svelte";
  import { arrivalOf, callDuration } from "../toolTimings";
  import { sameRun } from "../transcriptGroup";
  // The SAME module the server and the agent prompt use, so the header a reader
  // sees and the identity the agent is given can never be two different rules.
  import { senderDisplayName } from "../../../../src/channels/senderName";
  import UiComponent from "./ui/UiComponent.svelte";
  import VoiceNote from "./VoiceNote.svelte";

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
    | { kind: "channel"; event: Extract<RunEvent, { type: "channel" }> }
    | { kind: "step"; event: RunEvent };

  /** The most recent tool_call, used to pair a result that carries no id. */
  let lastCall: Extract<RunEvent, { type: "tool_call" }> | undefined;
  /** Its index in `out`, so pairing is O(1) instead of a scan per observation. */
  let lastCallIdx = -1;

  /** WhatsApp-style receipt per task bubble: one grey tick = sent; two ticks once the run ended (ok = accent, else warn). */
  const ticks = $derived.by(() => {
    const m = new Map<number, { two: boolean; ok: boolean; label: string }>();
    let task = -1;
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k]!;
      if (r.kind === "task") { task = k; m.set(k, { two: false, ok: true, label: "Enviado" }); }
      else if (r.kind === "exit" && task >= 0) m.set(task, { two: true, ok: r.event.exitStatus === "Submitted", label: r.event.exitStatus });
    }
    return m;
  });

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

  // Keep long saved conversations cheap to open. Earlier rows remain available in explicit
  // batches instead of mounting thousands of components before the latest answer can be read.
  const PAGE = 200;
  let shown = $state(PAGE);
  const start = $derived(Math.max(0, rows.length - shown));
  async function showEarlier(event: MouseEvent) {
    const scroller = (event.currentTarget as HTMLElement).closest("main");
    const height = scroller?.scrollHeight ?? 0;
    const top = scroller?.scrollTop ?? 0;
    shown += PAGE;
    await tick();
    if (scroller) scroller.scrollTop = top + scroller.scrollHeight - height;
  }

  /**
   * Consecutive messages of the same author group together (the chat-app
   * rule): the first of a run keeps the full gap and a quiet timestamp, the
   * rest tuck close under it. Anything else (a tool card, a notice) breaks
   * the run.
   */
  const GAP = "mt-3.5 pane-sm:mt-3";
  const TUCK = "mt-1";

  /** Consecutive messages of the SAME author keep one header (transcriptGroup.ts). */
  function grouped(prev: Row | undefined, row: Row) {
    if (row.kind !== "assistant" && row.kind !== "task" && row.kind !== "channel") return false;
    return sameRun(
      prev && (prev.kind === "assistant" || prev.kind === "task" || prev.kind === "channel")
        ? { kind: prev.kind, sender: prev.kind === "channel" ? prev.event.sender : undefined }
        : undefined,
      { kind: row.kind, sender: row.kind === "channel" ? row.event.sender : undefined },
    );
  }

  /**
   * Who a mirrored row reads as. The delivery carries the sender's chosen name
   * alongside the jid, and this is the ONE place the transcript decides what to
   * print: name when there is a usable one, jid (domain stripped) otherwise.
   * The rule itself lives in src/channels/senderName.ts so the agent's prompt and
   * this header cannot drift apart — they answer the same question for the same
   * delivery.
   */
  function senderName(sender: string, name?: string): string {
    return senderDisplayName(sender, name);
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
  let copiedId = $state<string | null>(null);
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
  {#if start > 0}
    <button type="button" class="mx-auto my-3 rounded-lg border border-line px-4 py-2 text-[13px] text-ink-muted hover:bg-raised" onclick={showEarlier}>
      Show earlier messages ({start} more)
    </button>
  {/if}
  {#each rows.slice(start) as row, offset (start + offset)}
    {@const i = start + offset}
    {@const prev = i > start ? rows[i - 1] : undefined}
    {@const isGrouped = grouped(prev, row)}
    {@const gap = i === 0 ? "" : isGrouped ? TUCK : GAP}
    {#if row.kind === "task"}
      <!-- The user speaks in the near-black bubble, at the right (the mockup's). -->
      <div class="cv-row turn group/turn flex flex-col items-end {gap}">
        {#if !isGrouped}
          {@const at = clock(row.event)}
          {#if at}<div class="tnum pointer-coarse:px-1 pr-1 text-[10px] leading-3 text-ink-faint">{at}</div>{/if}
        {/if}
        <div class="flex items-end gap-1">
          <div class="msg-user max-w-[85%] rounded-2xl rounded-br-md bg-bubble-user px-3.5 py-2 pointer-coarse:px-4">
            <Markdown text={row.event.text} class="read-[14px] leading-[1.55] text-bubble-user-ink" />
            {#each (row.event.attachments ?? []).filter((a) => a.kind === "audio" && a.url) as att (att.id)}
              <VoiceNote url={att.url!} name={att.name} />
            {/each}
            {#if ticks.get(i)}
              {@const t = ticks.get(i)!}
              <span class="ticks {t.two ? (t.ok ? 'ticks-ok' : 'ticks-warn') : ''}" role="img" aria-label={t.label} title={t.label}>
                <svg viewBox="0 0 18 11" width="16" height="10" fill="none" aria-hidden="true">
                  <path d="M1 5.8l3 3L10.2 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                  {#if t.two}<path class="t2" d="M7.2 8.2l.8.8L16 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>{/if}
                </svg>
              </span>
            {/if}
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
    {:else if row.kind === "channel"}
      <!-- Espejo: a message from the bound WhatsApp thread (never a turn).
           Discreet origin marker: the little bubble icon + sender. -->
      <div class="cv-row turn group/turn flex flex-col items-end {gap}">
        {#if !isGrouped}
          <div class="tnum pointer-coarse:px-1 flex items-center gap-1 pr-1 text-[10px] leading-3 text-ink-faint">
            <MessageCircle size={10} strokeWidth={2} aria-hidden="true" />
            <!-- `title` keeps the jid one hover away: the name is a
                 self-declared label, so anyone debugging "who was that?" needs
                 the identity the row is actually grouped by. -->
            <span title={row.event.sender}>{senderName(row.event.sender, row.event.senderName)}</span>
            {new Date(row.event.ts > 1e12 ? row.event.ts : row.event.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </div>
        {/if}
        <div class="flex items-end gap-1">
          <div class="msg-user wa-mirror max-w-[85%] rounded-2xl rounded-br-md bg-bubble-user px-3.5 py-2 pointer-coarse:px-4">
            {#if row.event.text.trim()}
              <Markdown text={row.event.text} class="read-[14px] leading-[1.55] text-bubble-user-ink" />
            {/if}
            {#each row.event.attachments as att (att.id)}
              {#if att.kind === "image" && att.url}
                <a href={att.url} target="_blank" rel="noreferrer" class="mt-1.5 block">
                  <img src={att.url} alt="imagen de WhatsApp" loading="lazy" class="max-h-64 w-auto rounded-lg" />
                </a>
              {:else if att.kind === "audio" && att.url}
                <VoiceNote url={att.url} />
              {:else if att.url}
                <a href={`${att.url}?dl=1`} target="_blank" rel="noreferrer" class="mt-1.5 flex items-center gap-1 read-[12px] underline decoration-dotted text-bubble-user-ink/80">
                  adjunto ({att.mime ?? att.kind})
                </a>
              {:else}
                <div class="mt-1.5 flex items-center gap-1 read-[12px] text-bubble-user-ink/60">
                  {att.kind === "image" ? " imagen" : att.kind === "audio" ? " nota de voz" : " adjunto"} (sin descargar)
                </div>
              {/if}
            {/each}
          </div>
          <button
            type="button"
            class="turn-action"
            aria-label="Copiar mensaje"
            onclick={() => copyTurn(row.event.text, `c${row.event.mirrorId}`)}
          >
            {#if copiedId === `c${row.event.mirrorId}`}
              <Check size={12} strokeWidth={2} aria-hidden="true" />
            {:else}
              <Copy size={12} strokeWidth={1.75} aria-hidden="true" />
            {/if}
          </button>
        </div>
      </div>
    {:else if row.kind === "assistant"}
      <!-- The bot answers in the soft grey bubble, at the left. -->
      <div class="cv-row turn group/turn flex flex-col items-start {gap}">
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
      <div class="cv-row {gap}"><StepCard event={row.event} /></div>
    {:else if row.kind === "ui-component"}
      <!-- Generative UI: a component of the closed set, validated before render. -->
      <div class="cv-row {gap} pl-1">
        <UiComponent template={row.event.template} props={row.event.props} {onsubmit} />
      </div>
    {:else if row.kind === "thinking"}
      <!--
        A finished thought is a one-line receipt, not a panel: the run's
        timeline stays scannable, and the text is available in <details>.
      -->
      {#if row.event.text}
        <details class="cv-row group/think {gap}">
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
      {#if /^\[subagent [^\]\n]+\] (finished its turn|stopped)/.test(row.event.text)}
        <details class="cv-row rounded-xl border border-line bg-raised/30 px-3 py-2 {gap}">
          <summary class="flex cursor-pointer list-none items-center gap-2 text-xs text-ink-muted">
            <CheckCircle2 size={14} class="shrink-0 text-brand" />
            <span class="min-w-0 flex-1 truncate">{row.event.text.split("\n")[0]}</span>
            <span class="shrink-0 text-ink-faint">Details</span>
          </summary>
          <p class="mt-3 whitespace-pre-wrap break-words text-xs text-ink-muted">{row.event.text}</p>
        </details>
      {:else}
        <div class="cv-row px-2.5 read-[11.5px] text-ink-faint {gap}">{row.event.text}</div>
      {/if}
    {:else if row.kind === "exit"}
      <!-- The run result is shown as the receipt ticks inside the task bubble. -->
    {:else if row.kind === "error"}
      <div class="cv-row flex items-start gap-2 rounded-2xl bg-err/10 px-3 py-2 read-[12.5px] text-err {gap}">
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

  /*
   * Dense transcripts (hundreds of rows) pay style/layout/paint for every row
   * at mount. Rows the viewport cannot see are skipped entirely until scrolled
   * to; `contain-intrinsic-size` keeps the scrollbar sized with an estimate
   * until a row renders, then remembers its real height. Tool cards (the tall
   * rows) sit near the 64px estimate's error only in scrollbar-thumb terms.
   */
  .ticks { display: flex; justify-content: flex-end; margin-top: 2px; color: var(--color-bubble-user-ink); opacity: .5; }
  .ticks-ok { color: #53bdeb; opacity: 1; }
  .ticks-warn { color: var(--color-warn, #d9a441); opacity: 1; }
  .ticks .t2 { animation: tick2 .35s ease-out both; }
  @keyframes tick2 { from { opacity: 0; transform: translateX(-3px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .ticks .t2 { animation: none; } }
  .cv-row {
    content-visibility: auto;
    contain-intrinsic-size: auto 64px;
  }

  /* Espejo: a mirrored WhatsApp bubble keeps its own bubble style plus a quiet
     green underline — the origin marker the timestamp row already names. */
  .wa-mirror {
    box-shadow: inset 0 -2px 0 var(--color-bubble-user-mirror);
  }

  /* Inside the bubble the palette flips: the prose-mini defaults assume a
     page-coloured surface and would vanish against the bubble's own ink.
     Every value here comes from a token because `--color-bubble-user`
     INVERTS with the mode (near-black in light, near-white in dark): the
     literals that used to live here were written for the dark bubble and only
     ever correct in one mode. Measured live against the deployed build, with a
     link, a quote, inline code and a code block inside one user message:
     the link read 1.67:1 and the quote 1.01:1 in dark mode — zero ink pixels,
     i.e. invisible — and 8.90 / 8.98 in light. See `--color-bubble-user-*`
     in app.css for the per-mode values. */
  .msg-user :global(.prose-mini a) {
    color: var(--color-bubble-user-link);
  }
  .msg-user :global(.prose-mini strong) {
    color: var(--color-bubble-user-ink);
  }
  .msg-user :global(.prose-mini code) {
    background: var(--color-bubble-user-chip);
  }
  .msg-user :global(.prose-mini pre) {
    background: var(--color-bubble-user-pre);
    border-color: var(--color-bubble-user-pre-line);
  }
  .msg-user :global(.prose-mini blockquote) {
    color: var(--color-bubble-user-quote);
  }
</style>
