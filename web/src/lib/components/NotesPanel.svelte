<script lang="ts">
  import { Copy, X, CircleAlert } from "@lucide/svelte";
  import Button from "./Button.svelte";
  import Skeleton from "./Skeleton.svelte";
  import { notes } from "../stores/notes.svelte";
  import { SAVE_DELAY, counts, statusText, type SaveState } from "../notes";
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
    /** The left edge of the pane the panel sits in, in the same pixels as the pointer. */
    paneLeft = 0,
  }: {
    noteId: string | null;
    title?: string;
    onclose: () => void;
    width?: number | null;
    onresize?: (px: number) => void;
    paneLeft?: number;
  } = $props();

  /** The panel itself, for the measures a drag needs. */
  let panel = $state<HTMLElement | null>(null);

  const uid = $props.id();
  let body = $state("");
  /** Version of the note this editor is based on. */
  let base = 0;
  /** What the server holds (as far as we know): nothing to save while `body` equals it. */
  let savedBody = "";
  let save = $state<SaveState>({ kind: "loading" });
  let area = $state<HTMLTextAreaElement | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | null = null;
  let now = $state(Date.now());
  const c = $derived(counts(body));

  // ---- free resize: the divider on the panel's left edge
  let edge = $state<HTMLElement | null>(null);
  let sizing = $state(false);

  /**
   * A drag of the panel's left edge. The measures are viewport pixels on both sides (the pane's own
   * zoom included), so the width comes out exact at any interface size; `sideWidthAt` then clamps it,
   * leaving the chat its share. Nothing is kept until the drag ends.
   */
  function startResize(event: PointerEvent) {
    if (event.button !== 0 || !onresize || !panel) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
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
    if (!id) {
      save = { kind: "saved", at: 0 };
      return;
    }
    save = { kind: "loading" };
    body = savedBody = "";
    base = 0;
    // Watch it through the hub: its value arrives now, and again whenever it changes anywhere.
    const release = notes.watch(id, (note) => {
      if (id !== noteId) return;
      if (save.kind === "loading") {
        body = savedBody = note.body;
        base = note.updatedAt;
        save = { kind: "saved", at: note.updatedAt };
        return;
      }
      if (note.updatedAt === base) return; // the version we already have
      if (body === savedBody && save.kind !== "saving") {
        // Nothing typed here since the last save: take theirs at once, keeping the caret where it was.
        const at = area?.selectionStart ?? 0;
        body = savedBody = note.body;
        base = note.updatedAt;
        save = { kind: "saved", at: note.updatedAt };
        queueMicrotask(() => area?.setSelectionRange(Math.min(at, body.length), Math.min(at, body.length)));
      } else {
        // You are typing: never overwrite what you wrote. Say so now, and let you choose.
        save = { kind: "conflict", theirs: note.body, theirsAt: note.updatedAt };
      }
    });
    return () => {
      void flush(id, true).finally(release);
    };
  });

  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 15_000);
    return () => clearInterval(t);
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
    if (save.kind === "conflict" || save.kind === "loading") return;
    save = body === savedBody ? { kind: "saved", at: base } : { kind: "dirty" };
    clearTimeout(timer);
    timer = setTimeout(() => noteId && void flush(noteId), SAVE_DELAY);
  }

  /**
   * Save now, one save at a time.
   *
   * What to save is captured before the first `await`: when the pane switches sessions, the effect's
   * cleanup calls this and the next run resets `body` straight after, so reading it later would save
   * the wrong note's text (or nothing). A save for a note that is no longer on screen uses the values
   * captured here; one for the current note re-reads them after waiting its turn, so a save that was
   * in flight has already moved the version on.
   */
  async function flush(id: string, _leaving = false): Promise<void> {
    clearTimeout(timer);
    const snap = { text: body, saved: savedBody, base, kind: save.kind };
    if (inFlight) await inFlight;
    const current = id === noteId;
    const text = current ? body : snap.text;
    const saved = current ? savedBody : snap.saved;
    const from = current ? base : snap.base;
    const kind = current ? save.kind : snap.kind;
    if (text === saved || kind === "conflict" || kind === "loading") return;
    if (current) save = { kind: "saving" };
    inFlight = (async () => {
      try {
        const result = await notes.save(id, text, from);
        if (id !== noteId) return; // switched away while it was saving: it landed, nothing to show
        if (result.ok) {
          base = result.note.updatedAt;
          savedBody = text;
          save = body === text ? { kind: "saved", at: result.note.updatedAt || Date.now() } : { kind: "dirty" };
          if (body !== text) timer = setTimeout(() => void flush(id), SAVE_DELAY); // typed during the save
        } else {
          save = { kind: "conflict", theirs: result.conflict.body, theirsAt: result.conflict.updatedAt };
        }
      } catch (error) {
        if (id === noteId) save = { kind: "error", message: (error as Error).message };
      }
    })();
    const mine = inFlight;
    await mine;
    if (inFlight === mine) inFlight = null;
  }

  /** Conflict: keep mine (overwrite theirs, deliberately) or take theirs (mine is copied first). */
  async function keepMine() {
    if (save.kind !== "conflict" || !noteId) return;
    base = save.theirsAt;
    savedBody = save.theirs;
    save = { kind: "dirty" };
    await flush(noteId);
  }
  async function takeTheirs() {
    if (save.kind !== "conflict") return;
    await copy(body); // what was typed here is on the clipboard, not gone
    body = savedBody = save.theirs;
    base = save.theirsAt;
    save = { kind: "saved", at: save.theirsAt };
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

  /** Double-clicking the divider gives the pane's default back (the least, then the CSS clamp takes over). */
  const SIDE_DEFAULT_RESET = SIDE_MAX;
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
      ondblclick={() => onresize?.(SIDE_DEFAULT_RESET)}
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
      {statusText(save, now)}
      {#if save.kind === "error"}
        <button type="button" class="interactive cursor-pointer rounded-sm px-1 font-medium text-ink underline underline-offset-2 pointer-coarse:min-h-11" onclick={() => noteId && void flush(noteId)}>Retry</button>
      {/if}
    </span>
    {#if noteId && save.kind !== "loading"}
      <span class="tnum ml-auto text-ink-faint">{c.words} {c.words === 1 ? "word" : "words"}</span>
    {/if}
  </footer>
</aside>
