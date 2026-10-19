<script lang="ts">
  import { Copy, X, CircleAlert } from "@lucide/svelte";
  import Button from "./Button.svelte";
  import Skeleton from "./Skeleton.svelte";
  import { notes } from "../stores/notes.svelte";
  import { counts, statusText, type SaveState } from "../notes";
  import { NoteEditor } from "../noteEditor";
  import { clock } from "../stores/clock.svelte";
  import { sideWidthAt, SIDE_MAX, SIDE_MIN } from "../sidePanel";

  /**
   * Notes beside a session: a plain text area that saves itself (see `lib/notes.ts` for the rules).
   * `noteId` is the session's id; a pane with no session yet has nowhere to keep notes, and the panel
   * says so instead of accepting text it would lose.
   */
  let {
    noteId,
    title = "",
    onclose,
    /** The width to draw the panel at, or null for the panel's own default. */
    width = null,
    /** Every width a drag lands on. Omitted: the panel keeps its CSS size and cannot be resized. */
    onresize,
    onreset,
    /** The left edge of the pane the panel sits in, in the same pixels as the pointer. */
    paneLeft = 0,
  }: {
    noteId: string | null;
    title?: string;
    onclose: () => void;
    width?: number | null;
    onresize?: (px: number) => void;
    /** A double-click on the divider: the width chosen for this pane is dropped. */
    onreset?: () => void;
    paneLeft?: number;
  } = $props();

  /** The panel itself, for the measures a drag needs. */
  let panel = $state<HTMLElement | null>(null);

  const uid = $props.id();
  let body = $state("");
  let area = $state<HTMLTextAreaElement | null>(null);
  /**
   * The save machine — what a flush sends, which version it names, and what the words on screen may
   * claim (`lib/noteEditor.ts`, driven by the tests; this file wires it and shows what it says).
   * `sync` mirrors its state into reactive land after every decision.
   */
  const ed = new NoteEditor(notes, sync, () => clock.now);
  let save = $state<SaveState>(ed.save);
  function sync() {
    body = ed.body;
    save = ed.save;
  }
  const c = $derived(counts(body));

  // ---- free resize: the divider on the panel's left edge
  let edge = $state<HTMLElement | null>(null);
  let sizing = $state(false);
  /** The last press on the divider, for a double-click (a `dblclick` event never arrives: see above). */
  let lastDown = 0;
  let lastX = 0;

  /**
   * A drag of the panel's left edge. The measures are viewport pixels on both sides (the pane's own
   * zoom included), so the width comes out exact at any interface size; `sideWidthAt` then clamps it,
   * leaving the chat its share. Nothing is kept until the drag ends.
   */
  function startResize(event: PointerEvent) {
    if (event.button !== 0 || !onresize || !panel) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    // The `preventDefault` above stops the browser's own double-click detection from ever seeing the
    // two presses, so a double-click is counted here: two presses, no drag between them, is one.
    const now = event.timeStamp;
    if (now - lastDown < 400 && Math.abs(lastX - event.clientX) < 4) {
      lastDown = 0;
      onreset?.();
      return;
    }
    lastDown = now;
    lastX = event.clientX;
    sizing = true;
  }
  function trackResize(event: PointerEvent) {
    if (!sizing || !onresize || !panel) return;
    const box = panel.getBoundingClientRect();
    const width = sideWidthAt(event.clientX, box.right, paneLeft);
    if (width !== null) onresize?.(width);
  }
  function endResize(event: PointerEvent) {
    if (!sizing) return;
    sizing = false;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    // A double-click fires two of these with the pointer still where it started: nothing was dragged,
    // so `dblclick` arrives after the capture was taken back. Nothing to do here but let it come.
  }

  /** A step on the keys is 24px: enough to feel, small enough to land near where you wanted. */
  const STEP = 24;
  function keyResize(event: KeyboardEvent) {
    const current = width ?? 320;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = current + STEP;
    else if (event.key === "ArrowRight") next = current - STEP;
    else if (event.key === "Home") next = SIDE_MAX;
    else if (event.key === "End") next = SIDE_MIN;
    if (next === null) return;
    event.preventDefault();
    onresize?.(next);
  }

  // Load when the note changes (the pane switched sessions). An unsaved edit to the previous note is
  // flushed first, against that note's id, so switching never drops text.
  $effect(() => {
    const id = noteId;
    ed.enter(id);
    if (!id) return;
    // A save this pane had given up on turned out to land (or to be refused): the machine corrects
    // both the version book and the verdict the panel has already shown.
    const releaseLate = notes.onLateSave((note, outcome) => ed.applyLate(note, outcome));
    // Watch it through the hub: its value arrives now, and again whenever it changes anywhere.
    const release = notes.watch(id, (note) => {
      const at = area?.selectionStart ?? 0;
      if (ed.applyRemote(id, note) === "took") {
        // The text moved under the caret (the other value was taken as ours): put it back.
        queueMicrotask(() => area?.setSelectionRange(Math.min(at, ed.body.length), Math.min(at, ed.body.length)));
      }
    });
    return () => {
      releaseLate();
      void ed.leave(id).finally(release);
    };
  });

  // The "Saved Ns ago" line is a claim about the clock (E53): this panel is woken exactly at the
  // moments those words can change. The old `setInterval(() => now = Date.now(), 15_000)` ran for
  // ever (open or not) and left the line up to 15 s behind what it claimed.
  $effect(() => {
    const s = save;
    if (s.kind !== "saved" || !s.at) return;
    return clock.watchAge("saved", s.at);
  });

  // Save as the page hides (tab switch, phone lock): the socket is still open at that moment, so the
  // save goes out on it. (A tab being closed outright can drop the last 600 ms of typing; the blur and
  // close saves below usually get there first.)
  $effect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden" && noteId) void flush(noteId);
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
    };
  });

  function oninput() {
    ed.type(body);
  }

  /** Save now: what to send and which version it names are the machine's (`noteEditor`). */
  async function flush(id: string, leaving = false): Promise<void> {
    await ed.flush(id, leaving);
  }

  /** Conflict: keep mine (overwrite theirs, deliberately) or take theirs (mine is copied first). */
  async function keepMine() {
    await ed.keepMine();
  }
  async function takeTheirs() {
    await copy(ed.body); // what was typed here is on the clipboard, not gone
    ed.takeTheirs();
  }

  let copied = $state(false);
  async function copy(text = body) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      /* clipboard refused (insecure context): nothing else to do */
    }
  }

  function onkeydown(event: KeyboardEvent) {
    // Ctrl/Cmd+S saves now instead of opening the browser's "save page".
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (noteId) void flush(noteId);
    } else if (event.key === "Escape") {
      event.preventDefault();
      void close();
    }
  }

  async function close() {
    if (noteId) await flush(noteId);
    onclose();
  }

  /** Focus the text area; if the note is still loading, focus it as soon as it appears. */
  let wantFocus = false;
  export function focus() {
    if (area) area.focus();
    else wantFocus = true;
  }
  $effect(() => {
    if (area && wantFocus) {
      wantFocus = false;
      area.focus();
    }
  });

  const tone = $derived(save.kind === "error" || save.kind === "conflict" ? "text-err" : save.kind === "dirty" || save.kind === "saving" ? "text-ink-muted" : "text-ink-faint");

</script>

<aside bind:this={panel} class="notes relative flex min-h-0 w-full flex-1 flex-col bg-surface" class:is-sizing={sizing} aria-labelledby="{uid}-title">
  {#if onresize}
    <!-- A focusable separator is the ARIA pattern for a resizer ("window splitter"): it is interactive. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      bind:this={edge}
      role="separator"
      tabindex="0"
      aria-orientation="vertical"
      aria-label="Resize notes"
      aria-valuetext={width ? `${width} pixels wide` : "default width"}
      title="Drag to resize. Double-click for the default width."
      class="side-edge absolute inset-y-0 left-0 z-10 w-px cursor-col-resize"
      class:is-dragging={sizing}
      onpointerdown={startResize}
      onpointermove={trackResize}
      onpointerup={endResize}
      onpointercancel={endResize}
      ondblclick={() => onreset?.()}
      onkeydown={keyResize}
    ></div>
  {/if}
  <header class="flex min-h-11 shrink-0 items-center gap-1 border-b border-line/80 py-1 pr-1.5 pl-3.5">
    <div class="min-w-0 flex-1">
      <h2 id="{uid}-title" class="text-[13px] leading-4 font-medium text-ink">Notes</h2>
      {#if title}<p class="truncate text-[11px] leading-4 text-ink-faint">{title}</p>{/if}
    </div>
    <Button variant="ghost" size="icon-sm" icon={Copy} title={copied ? "Copied" : "Copy notes"} aria-label={copied ? "Copied" : "Copy notes"} disabled={!body} onclick={() => copy()} />
    <Button variant="ghost" size="icon-sm" icon={X} title="Close notes" aria-label="Close notes" onclick={close} />
  </header>

  {#if !noteId}
    <div class="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p class="text-[13px] text-ink">Notes belong to a session.</p>
      <p class="text-[12.5px] text-ink-muted">Send the first message in this pane, then write here.</p>
    </div>
  {:else if save.kind === "loading"}
    <div class="flex flex-col gap-2 p-3.5" role="status" aria-label="Loading notes">
      <Skeleton class="h-3.5 w-3/4" /><Skeleton class="h-3.5 w-1/2" /><Skeleton class="h-3.5 w-2/3" />
    </div>
  {:else}
    {#if save.kind === "conflict"}
      <div class="m-2.5 flex flex-col gap-2 rounded-lg border border-err/40 bg-err/5 p-3" role="alert">
        <p class="flex items-start gap-2 text-[12.5px] text-ink">
          <CircleAlert size={14} strokeWidth={2} class="mt-px shrink-0 text-err" aria-hidden="true" />
          These notes were saved from another tab or device while you were typing.
        </p>
        <div class="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onclick={takeTheirs} title="Load the other version; your text is copied to the clipboard first">Use theirs</Button>
          <Button variant="primary" size="sm" onclick={keepMine}>Keep mine</Button>
        </div>
      </div>
    {/if}
    <label for="{uid}-body" class="sr-only">Notes for {title || "this session"}</label>
    <textarea
      id="{uid}-body"
      bind:this={area}
      bind:value={body}
      {oninput}
      {onkeydown}
      onblur={() => noteId && void flush(noteId)}
      placeholder="Write anything: a plan, commands to try, what to check next. It saves as you type."
      spellcheck="true"
      aria-describedby="{uid}-status"
      readonly={save.kind === "conflict"}
      class="read-[16px] min-h-0 flex-1 resize-none bg-transparent px-3.5 py-3 leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none"
    ></textarea>
  {/if}

  <footer class="flex min-h-9 shrink-0 items-center gap-2 border-t border-line/80 px-3.5 pb-[env(safe-area-inset-bottom)] text-[11.5px]">
    <span id="{uid}-status" class="flex items-center gap-1.5 {tone}" role="status" aria-live="polite">
      <span class="size-1.5 rounded-full {save.kind === 'error' || save.kind === 'conflict' ? 'bg-err' : save.kind === 'saved' ? 'bg-ok' : 'bg-warn'}" aria-hidden="true"></span>
      {statusText(save, clock.now)}
      {#if save.kind === "error"}
        <button type="button" class="interactive cursor-pointer rounded-sm px-1 font-medium text-ink underline underline-offset-2 pointer-coarse:min-h-11" onclick={() => noteId && void flush(noteId)}>Retry</button>
      {/if}
    </span>
    {#if noteId && save.kind !== "loading"}
      <span class="tnum ml-auto text-ink-faint">{c.words} {c.words === 1 ? "word" : "words"}</span>
    {/if}
  </footer>
</aside>

<style>
  /* The grab area: invisible, centred on the 1px line, wider under a finger. */
  .side-edge::before {
    content: "";
    position: absolute;
    inset: 0 -5px;
    touch-action: none;
  }
  @media (pointer: coarse) {
    .side-edge::before {
      inset: 0 -11px;
    }
  }
  /* Hover, drag and keyboard focus all say "this moves", in colour, never by motion alone. */
  .side-edge {
    transition: background-color 150ms cubic-bezier(0.2, 0, 0, 1);
  }
  .side-edge:hover,
  .side-edge.is-dragging,
  .side-edge:focus-visible {
    background: var(--color-brand);
    box-shadow: 0 0 0 1px var(--color-brand);
    outline: none;
  }
  /* While a drag is on, the notes are not a place to be selecting text by accident. */
  aside.notes.is-sizing {
    user-select: none;
  }
</style>
