<script lang="ts">
  import { ArrowUp, Square, Terminal as TerminalIcon, Globe, Paperclip, FileText, X, CircleAlert, Mic } from "@lucide/svelte";
  import { onDestroy, untrack } from "svelte";
  import Chip from "./Chip.svelte";
  import Button from "./Button.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import CompletionMenu from "./CompletionMenu.svelte";
  import { catalog } from "../stores/catalog.svelte";
  import { completionAt, pickCompletion } from "../completion";
  import { skillQueryAt } from "../../../../src/skillMatch";
  import { addChip, announce, composePrompt, hasMessage, removeChip, type Chip as ChipT } from "../chips";
  import { step } from "../models";
  import { fitHeight } from "../grow";
  import type { PromptMemory } from "../promptMemory";
  import { humanSize, uploadAttachment, ATTACH_ACCEPT, ATTACH_MAX, type AttachmentRef } from "../attachments";
  import {
    abandonDraft,
    beginUpload,
    cancelAllUploads,
    cancelUpload,
    createUploadState,
    isCancel,
    isCurrent,
    pendingUploads,
    settleUpload,
  } from "../attachmentUpload";
  import AudioRecorder from "./control-ui/AudioRecorder.svelte";
  import { preferredAudioMimeType, type AudioRecording } from "../control-ui/recorder.svelte";
  import { recorderCanDiscard } from "../recorderBar";
  import { toasts } from "../stores/toast.svelte";

  /**
   * The prompt bar. One surface, one row of controls: where the run executes, which model, and
   * send. Everything has a text name for assistive tech (icons are decoration), Enter sends,
   * Shift+Enter breaks the line, and the hint that says so is read out via `aria-describedby`.
   */
  let {
    value = $bindable(""),
    chips = $bindable<ChipT[]>([]),
    attachments = $bindable<AttachmentRef[]>([]),
    running = false,
    sending = false,
    targets = [],
    targetId = "local",
    ontarget,
    model = "",
    switchingModel = false,
    modelNote = "",
    modelOpen = $bindable(false),
    disabled = false,
    /**
     * E39: which conversation this prompt bar is writing for (the pane's session, "" for a
     * new chat). It changes when the user moves to another conversation, which is exactly when
     * a still-uploading file stops belonging to what is on screen.
     */
    draftKey = "",
    /**
     * Float as a pill over the content (absolute in the pane's overlay layer) instead of a solid
     * full-width band: the transcript keeps the pane's full height behind it.
     */
    floating = false,
    onsend,
    oninterrupt,
    onmodel,
    memory,
  }: {
    /** ↑/↓ recall of the prompts sent in this chat (see lib/promptMemory.ts). */
    memory?: PromptMemory;
    /** Which conversation this bar writes for; changes when the pane moves to another. */
    draftKey?: string;
    value?: string;
    /** Commands and skills picked from the menus; joined to `value` only when the message is sent. */
    chips?: ChipT[];
    /** Files uploaded for this message (kept by the pane, sent as ids). */
    attachments?: AttachmentRef[];
    running?: boolean;
    /** A send is in flight. */
    sending?: boolean;
    /**
     * Where a *new* chat will run: "local" plus one entry per configured host. Empty hides the
     * control, which is the case for an existing chat (it already runs somewhere) and for a
     * machine with no remote hosts (nothing to choose).
     */
    targets?: { id: string; label: string }[];
    targetId?: string;
    ontarget?: (id: string) => void;
    model?: string;
    switchingModel?: boolean;
    modelNote?: string;
    /** Bindable so `/model` can open the picker. */
    modelOpen?: boolean;
    disabled?: boolean;
    /** Render as a floating pill over the content instead of a solid band below the transcript. */
    floating?: boolean;
    /** `text` is the finished message: chips first, then what was typed. */
    onsend: (text: string) => void;
    oninterrupt: () => void;
    onmodel: (id: string) => void;
  } = $props();

  const uid = $props.id();
  /**
   * Box of the field and of its mirror: they must match exactly or the measured height is wrong.
   * One line = 26px of text + 18px of padding = 44px, which is also the touch target.
   */
  const FIELD = "block w-full bg-transparent px-3.5 py-[9px] read-[16px] leading-relaxed text-ink placeholder:text-ink-faint";
  let area = $state<HTMLTextAreaElement | null>(null);
  /** Focus the prompt (after `/new`, after closing a panel). */
  export function focus() {
    area?.focus();
  }

  // ---- attachments: pick, drop, upload
  /**
   * E39: uploads are owned by a registry (`attachmentUpload.ts`, no Svelte so a test can
   * hold it), not by a local list that only knew when to push a result.
   *
   * What was measured on the deployed build: the in-flight chip had NO button at all, so a
   * stalled upload could not be cancelled and `canSend` stayed false at t+2.5, t+12, t+22 and
   * t+42 s; and the answer landing after the user had switched conversation attached the file
   * to the NEXT message -- measured body: `POST /api/sessions {"prompt":"hola, esto es otra
   * cosa", ... "attachments":[{"name":"secreto-e39.png"}]}`.
   *
   * So: every upload takes a real `AbortController` (the chip's button, `abandonDraft` when
   * the pane shows another conversation, unmount, and the deadline all cancel it), and an
   * answer may only attach while it is still the one this draft is waiting for.
   */
  const uploads = createUploadState();
  /** Files on their way to the server; the finished ones move into `attachments`. */
  let uploading = $state<{ key: string; name: string; size: number }[]>([]);
  let fileInput = $state<HTMLInputElement | null>(null);
  let dragging = $state(false);
  const canSend = $derived((hasMessage(chips, value) || attachments.length > 0) && !uploading.length && !disabled && !sending);

  /** Repaint the chip row from the registry (a new array, so Svelte sees the change). */
  function syncUploads() {
    uploading = pendingUploads(uploads);
  }

  /**
   * Run one upload to completion. Returns whether its file joined `attachments`: a cancelled
   * or superseded answer does not, and must not be able to later -- which is why the check is
   * `isCurrent(uploads, token)` and not "did we get a result".
   */
  async function runUpload(file: File, key: string): Promise<boolean> {
    const token = beginUpload(uploads, file, key);
    syncUploads();
    try {
      const ref = await uploadAttachment(file, token.controller.signal);
      if (!isCurrent(uploads, token)) return false;
      attachments = [...attachments, ref];
      return true;
    } finally {
      settleUpload(uploads, token);
      syncUploads();
    }
  }

  /** Cancel one upload: the chip's button. Aborting settles the request for real. */
  function cancelUploadByKey(key: string) {
    if (cancelUpload(uploads, key)) syncUploads();
  }

  // Another conversation: nothing still in flight belongs to it. Measured without this, the
  // answer landed in the fresh draft and rode out with the NEXT message the user typed.
  $effect(() => {
    draftKey;
    const dropped = abandonDraft(uploads);
    if (dropped) syncUploads();
  });

  // Leaving the pane takes its uploads with it: an answer nobody is waiting for must not
  // reach a pane that is gone.
  onDestroy(() => {
    cancelAllUploads(uploads);
  });

  function pickFiles() {
    fileInput?.click();
  }

  async function addFiles(list: FileList | File[]) {
    const files = [...list].slice(0, 10 - attachments.length - uploading.length);
    for (const file of files.slice(0, 10)) {
      if (file.size > ATTACH_MAX) {
        toasts.push(`${file.name} pasa de ${Math.round(ATTACH_MAX / 1024 / 1024)} MB`, { tone: "err" });
        continue;
      }
      const key = `${file.name}:${file.size}:${Math.random().toString(36).slice(2, 7)}`;
      try {
        await runUpload(file, key);
      } catch (error) {
        // A cancel is the user pressing the chip's button (or switching conversation, or the
        // deadline firing): not something the server refused, so it is not painted as one.
        if (!isCancel(error)) {
          toasts.push("Could not attach the file", { detail: (error as Error).message, tone: "err" });
        }
      }
    }
  }

  function removeAttachment(index: number) {
    attachments = attachments.filter((_, i) => i !== index);
    area?.focus();
  }

  // ---- voice notes: recorded in the pill, uploaded like any other file
  /** The recorder row only exists once there is something to show or cancel. */
  let recordingOpen = $state(false);

  /**
   * The blob becomes a real `.webm`/`.m4a` file and goes through
   * `uploadAttachment`, i.e. the exact same POST a picked file makes. From
   * there it is an ordinary attachment: it rides the prompt to the agent and
   * comes back out on the normal output path to WhatsApp, with no audio-only
   * side channel anywhere.
   *
   * E21: a failed upload RETHROWS. It used to swallow the error, which made the
   * recorder's `submitRecording` see a resolved promise and reset to `idle` with
   * `recording: undefined` — the take was gone and nothing on screen said so.
   * Throwing lands the recorder in the state it has for exactly this (`recorded`
   * with the blob kept and the reason attached), where "Enviar" is still there
   * for the retry. The toast stays; it is the transient half, not the whole news.
   */
  async function attachRecording(recording: AudioRecording) {
    // MediaRecorder hands back a container type ("audio/webm;codecs=opus");
    // the extension the server allowlists is what decides the stored mime, so
    // it is derived from the codec rather than from the raw type string.
    const type = recording.mimeType || recording.blob.type || "";
    const ext = type.includes("mp4") || type.includes("aac") ? "m4a" : "webm";
    const stamp = new Date().toISOString().slice(11, 19).replaceAll(":", "-");
    const file = new File([recording.blob], `nota-de-voz-${stamp}.${ext}`, { type: ext === "m4a" ? "audio/mp4" : "audio/webm" });
    const key = `voice:${file.name}`;
    try {
      const attached = await runUpload(file, key);
      // A cancelled or superseded upload keeps the take: the recorder's `recorded` state is
      // exactly where a failed upload belongs, and "Enviar" is still there for the retry.
      if (!attached) throw new DOMException("upload cancelled", "AbortError");
      recordingOpen = false;
      area?.focus();
    } catch (error) {
      if (!isCancel(error)) {
        toasts.push("No se pudo adjuntar la nota de voz", { detail: (error as Error).message, tone: "err" });
      }
      throw error;
    }
  }

  /**
   * The outer mic toggles the panel, but it must not be a silent shredder: with
   * E21 the recorder keeps its take in `recorded`, and unmounting it runs
   * `destroy()`. So closing over a take in hand asks first, and a plain close is
   * only allowed when there is nothing to lose.
   *
   * `recordingBusy` is true while there is anything the panel would throw away.
   */
  let recordingBusy = $state(false);
  let confirmClose = $state(false);
  /** The mic that opened the panel, so it can take the focus back when it closes. */
  let micEl = $state<HTMLButtonElement | null>(null);

  function toggleRecording() {
    if (!recordingOpen) {
      confirmClose = false;
      recordingOpen = true;
      return;
    }
    // Closing the panel with nothing in it (idle, or the mic never granted).
    if (!recordingBusy) {
      recordingOpen = false;
      return;
    }
    confirmClose = true;
  }

  /** Confirming the close is the only path that throws a recorded take away. */
  function closeRecordingAnyway() {
    confirmClose = false;
    recordingBusy = false;
    recordingOpen = false;
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    if (event.dataTransfer?.files?.length) void addFiles(event.dataTransfer.files);
  }
  function onDragOver(event: DragEvent) {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    dragging = true;
  }

  /** What a screen reader hears when the rail changes (a chip appearing is otherwise silent). */
  let liveMessage = $state("");

  function send() {
    if (!canSend) return;
    const message = composePrompt(chips, value);
    // Recall is a convenience: whatever happens to it, the message still goes out.
    if (message) {
      try {
        memory?.push({ chips: [...chips], text: value });
      } catch (error) {
        console.error("prompt memory", error);
      }
    }
    onsend(message);
  }

  /**
   * ↑ on the first line recalls the previous prompt, ↓ on the last line the next one (then the draft).
   * Inside a multi-line message the arrows keep moving the caret, as in any text field and as in the
   * terminal UI. A recalled message is put back with its chips, and the menu stays shut on it.
   */
  function recall(dir: "prev" | "next"): boolean {
    if (!memory || !area) return false;
    const at = area.selectionStart ?? 0;
    if (area.selectionEnd !== at) return false; // a selection: the arrows collapse it
    const onFirst = !value.slice(0, at).includes("\n");
    const onLast = !value.slice(at).includes("\n");
    if (dir === "prev" ? !onFirst : !onLast) return false;
    const got = dir === "prev" ? memory.prev({ chips: [...chips], text: value }) : memory.next();
    if (!got) return false;
    chips = got.chips;
    value = got.text;
    dismissed = `recall:${got.text}`;
    queueMicrotask(() => {
      if (!area) return;
      const end = dir === "prev" ? got.text.length : got.text.length;
      area.setSelectionRange(end, end);
      caret = end;
    });
    return true;
  }

  function remove(index: number) {
    const gone = chips[index];
    if (!gone) return;
    chips = removeChip(chips, index);
    liveMessage = announce("removed", gone);
    area?.focus();
  }

  /**
   * The bar is one line when empty and grows a line at a time up to five, then scrolls (`lib/grow.ts`).
   *
   * The height is measured on a hidden mirror (same width, font and padding), never on the field
   * itself, so the visible box is not collapsed and re-expanded on every keystroke. The result is
   * snapped to whole lines and written as an explicit height, which CSS eases (see `.auto-grow`): a new
   * wrapped line slides in, and a large paste eases up to the cap instead of snapping to it.
   * The placeholder is not measured, so a long one can never make an empty bar two lines tall.
   */
  let mirror = $state<HTMLDivElement | null>(null);
  let boxHeight = $state<number | undefined>(undefined);
  let scrolls = $state(false);

  function measure() {
    if (!area || !mirror) return;
    const cs = getComputedStyle(area);
    const line = parseFloat(cs.lineHeight) || 26;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const fit = fitHeight(mirror.offsetHeight, line, pad);
    boxHeight = fit.height;
    scrolls = fit.scrolls;
    // While typing at the end of a scrolling field, keep the newest line fully in view. The browser
    // scrolls the caret into view against the height the field had *before* this change landed, which
    // can leave the last line's spacing a few px under the edge. Only when the caret is at the end,
    // so editing in the middle of a long message never yanks the view away.
    if (fit.scrolls && area.selectionStart === value.length) {
      requestAnimationFrame(() => {
        if (area && area.selectionStart === value.length) area.scrollTop = area.scrollHeight;
      });
    }
  }

  // The template has already written the new text into the mirror when an effect runs.
  $effect(() => {
    value;
    measure();
  });

  // A different width re-wraps the text (rotation, the sessions drawer, a resize, fonts arriving).
  $effect(() => {
    if (!mirror) return;
    let width = mirror.clientWidth;
    const observer = new ResizeObserver(() => {
      if (mirror && mirror.clientWidth !== width) {
        width = mirror.clientWidth;
        measure();
      }
    });
    observer.observe(mirror);
    void document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  });

  // ---- completion: `/command` at the start, `$skill` anywhere
  let caret = $state(0);
  let active = $state(0);
  let dismissed = $state("");
  const completion = $derived(completionAt(value, caret, catalog.commands, catalog.skills));
  // A skill added on disk since the page loaded must show up: refresh the list when a `$` starts.
  const skillQuery = $derived(skillQueryAt(value, caret));
  $effect(() => {
    if (skillQuery?.query === "") untrack(() => catalog.refreshSkills());
  });
  // Escape hides the menu for the text it was open on; typing again brings it back.
  // A recalled message never opens the menu: ↑ would then move in the menu instead of the memory.
  const menu = $derived(completion && dismissed !== `${completion.kind}:${value}` && dismissed !== `recall:${value}` ? completion : null);
  const menuId = `${uid}-menu`;

  $effect(() => {
    menu?.query;
    menu?.kind;
    active = 0;
  });

  function syncCaret() {
    caret = area?.selectionStart ?? value.length;
  }

  function pick(index: number) {
    if (!menu) return;
    const next = pickCompletion(value, caret, menu, index);
    const added = addChip(chips, next.chip);
    if (added === chips) {
      // A rule refused it (a second command, a duplicate skill): say so instead of doing nothing.
      liveMessage = `${next.chip.kind === "command" ? "Command" : "Skill"} ${next.chip.name} is already in the message`;
      return;
    }
    chips = added;
    liveMessage = announce("added", next.chip);
    value = next.text;
    caret = next.cursor;
    // Put the caret after the inserted text once the value has been written back.
    queueMicrotask(() => {
      area?.focus();
      area?.setSelectionRange(next.cursor, next.cursor);
    });
  }

  function onkeydown(event: KeyboardEvent) {
    if (menu && !event.isComposing) {
      const n = menu.items.length;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        active = step(active, 1, n);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        active = step(active, -1, n);
        return;
      }
      // Enter and Tab complete; a command that needs no argument is still only *filled*, never
      // run, so a stray Enter cannot fire /new or /compact. Send is a second, deliberate Enter.
      if (event.key === "Enter" || event.key === "Tab") {
        if (event.shiftKey) return;
        event.preventDefault();
        pick(active);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        dismissed = `${menu.kind}:${value}`;
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
      return;
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && !event.isComposing) {
      if (recall(event.key === "ArrowUp" ? "prev" : "next")) event.preventDefault();
      return;
    }
    // Backspace at the very start of an empty caret removes the last chip, like a token field.
    if (event.key === "Backspace" && chips.length && (area?.selectionStart ?? 0) === 0 && (area?.selectionEnd ?? 0) === 0) {
      event.preventDefault();
      remove(chips.length - 1);
    }
  }
</script>

<div
  class={floating
    ? "pointer-events-none absolute inset-x-4 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-25 pane-sm:inset-x-3"
    : "shrink-0 bg-canvas px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pane-sm:px-3"}
>
  <div
    class={floating
      ? "pill-float isolate pointer-events-auto relative mx-auto max-w-3xl rounded-[26px] border border-line/60 shadow-[0_12px_32px_-12px_oklch(0_0_0/0.3)] transition-[border-color,box-shadow] duration-(--duration-fast) ease-(--ease-standard) focus-within:border-brand focus-within:shadow-[0_0_0_3px_var(--color-brand-soft),0_12px_32px_-12px_oklch(0_0_0/0.3)]"
      : "relative mx-auto max-w-3xl rounded-[26px] border border-transparent bg-raised transition-[border-color,box-shadow,background-color] duration-(--duration-fast) ease-(--ease-standard) focus-within:border-brand focus-within:bg-canvas focus-within:shadow-[0_0_0_3px_var(--color-brand-soft)]"}
    ondragover={onDragOver}
    ondragleave={() => (dragging = false)}
    ondrop={onDrop}
  >
    {#if dragging}
      <div class="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-[26px] border-2 border-dashed border-brand bg-brand-soft/60 text-[13px] font-medium text-ink" aria-hidden="true">
        Suelta los archivos aquí
      </div>
    {/if}
    {#if menu}
      <CompletionMenu completion={menu} {active} id={menuId} onpick={pick} onhover={(i) => (active = i)} />
    {/if}
    {#if chips.length}
      <ul class="flex flex-wrap gap-1.5 px-2.5 pt-2.5" aria-label="Added to this message">
        {#each chips as chip, i (chip.kind + chip.name)}
          <li class="max-w-full"><Chip {chip} onremove={() => remove(i)} /></li>
        {/each}
      </ul>
    {/if}
    {#if attachments.length || uploading.length}
      <ul class="flex flex-wrap gap-1.5 px-2.5 pt-2.5" aria-label="Archivos adjuntos">
        {#each attachments as att, i (att.id)}
          <li class="group/att flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-line bg-canvas py-1 pl-2 pr-1 text-[12px]">
            <FileText size={13} strokeWidth={1.75} class="shrink-0 text-ink-muted" aria-hidden="true" />
            <span class="max-w-44 truncate text-ink" title={att.name}>{att.name}</span>
            <span class="tnum shrink-0 text-ink-faint">{humanSize(att.size)}</span>
            <button
              type="button"
              class="interactive grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-ink-faint hover:bg-raised hover:text-ink pointer-coarse:size-11"
              aria-label="Quitar {att.name}"
              onclick={() => removeAttachment(i)}
            >
              <X size={12} strokeWidth={2} aria-hidden="true" />
            </button>
          </li>
        {/each}
        {#each uploading as up (up.key)}
          <!--
            E39: this chip used to render a spinner, a name and NOTHING else, so a stalled
            upload had no way out and Send stayed disabled with no button to press (measured
            disabled at t+42 s). Cancel is a real abort, not a spinner swap.
          -->
          <li class="flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-line/70 bg-canvas py-1 pl-2 pr-1 text-[12px] text-ink-faint">
            <span class="sr-only">{up.name}:</span>
            <span class="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-line-strong border-t-brand" aria-hidden="true"></span>
            <span class="max-w-44 truncate" title={up.name} aria-hidden="true">{up.name}</span>
            <span class="tnum shrink-0" aria-hidden="true">{humanSize(up.size)}</span>
            <button
              type="button"
              class="interactive grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-ink-faint hover:bg-raised hover:text-ink pointer-coarse:size-11"
              aria-label="Cancel the upload of {up.name}"
              title="Cancel this upload"
              onclick={() => cancelUploadByKey(up.key)}
            >
              <X size={12} strokeWidth={2} aria-hidden="true" />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if recordingOpen}
      <!-- Inside the pill, above the field. Control UI's AudioRecorder, ported
           to Svelte 5; the take is uploaded exactly like a picked file. -->
      <div id="{uid}-recorder" class="mx-2.5 mt-2 flex min-w-0 items-center rounded-xl border border-line bg-canvas/70 px-1.5 py-1">
        <AudioRecorder
          disabled={disabled || sending}
          onRecordingComplete={attachRecording}
          onstatechange={(next) => (recordingBusy = recorderCanDiscard(next))}
          onCancel={() => {
            recordingOpen = false;
            confirmClose = false;
          }}
          onDiscard={() => micEl?.focus()}
        />
        <!-- E21: closing the panel over a recorded take asks first. Unmounting the
             recorder destroys the controller, and the blob only exists in memory. -->
        {#if confirmClose}
          <div
            role="alertdialog"
            aria-modal="false"
            aria-label="Descartar la nota de voz"
            class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 pr-1 text-[12px] text-ink-muted"
          >
            <span class="min-w-0">¿Descartar la nota de voz?</span>
            <button
              type="button"
              class="interactive h-7 shrink-0 cursor-pointer rounded-md border border-line px-2 text-[12px] font-medium text-ink hover:bg-raised"
              onclick={closeRecordingAnyway}
            >
              Descartar
            </button>
            <button
              type="button"
              class="interactive h-7 shrink-0 cursor-pointer rounded-md px-2 text-[12px] font-medium text-brand hover:bg-raised"
              onclick={() => (confirmClose = false)}
            >
              Seguir grabando
            </button>
          </div>
        {/if}
      </div>
    {/if}
    <!-- Measuring copy of the text: same box as the field, invisible, inert, clipped to the bar. -->
    <div aria-hidden="true" class="pointer-events-none invisible absolute inset-0 overflow-hidden">
      <div bind:this={mirror} class="{FIELD} whitespace-pre-wrap [overflow-wrap:anywhere]">{value}&#8203;</div>
    </div>
    <textarea
      bind:this={area}
      bind:value
      {disabled}
      {onkeydown}
      onkeyup={syncCaret}
      onclick={syncCaret}
      oninput={() => {
        // Any edit re-arms the menu that Escape dismissed, even one that lands on the same text.
        dismissed = "";
        syncCaret();
      }}
      onselect={syncCaret}
      role="combobox"
      aria-expanded={!!menu}
      aria-controls={menu ? menuId : undefined}
      aria-autocomplete="list"
      aria-activedescendant={menu ? `${menuId}-opt-${active}` : undefined}
      rows="1"
      placeholder={chips.some((c) => c.kind === "command") ? "Add an argument, or press Enter" : running ? "Send a follow-up…" : "Message mini-tui…"}
      aria-label="Prompt"
      aria-describedby="{uid}-hint"
      enterkeyhint="send"
      autocapitalize="sentences"
      style:height={boxHeight === undefined ? undefined : `${boxHeight}px`}
      style:overflow-y={scrolls ? "auto" : "hidden"}
      class="auto-grow {FIELD} resize-none focus:outline-none disabled:opacity-50"
    ></textarea>
    <p id="{uid}-hint" class="sr-only">Enter sends. Shift and Enter add a new line. Type slash for commands or dollar for skills. Backspace at the start removes the last chip.</p>
    <p class="sr-only" role="status" aria-live="polite">{liveMessage}</p>

    <!-- The controls wrap onto a second row when a narrow bar cannot fit them (a small phone at a large
         interface size), rather than pushing Send off the edge. Send stays last, on the right. -->
    <div class="flex flex-wrap items-center gap-1 px-1.5 pb-1.5">
      {#if targets.length}
        <!-- Where a new chat runs. Explicit, never implicit; gone once the chat exists. -->
        <div class="flex min-w-0 shrink items-center rounded-md" role="group" aria-label="Run on">
          {#each [{ id: "local", label: "Local" }, ...targets] as t (t.id)}
            <button
              type="button"
              class="interactive flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium pointer-coarse:h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center pointer-coarse:px-3
                {targetId === t.id ? 'bg-raised text-ink' : 'text-ink-muted hover:text-ink'}"
              aria-pressed={targetId === t.id}
              title={t.id === "local" ? "Run on this machine" : `Run headless on ${t.label} over SSH`}
              onclick={() => ontarget?.(t.id)}
            >
              {#if t.id === "local"}
                <TerminalIcon size={13} strokeWidth={2} class="shrink-0" aria-hidden="true" />
              {:else}
                <Globe size={13} strokeWidth={2} class="shrink-0" aria-hidden="true" />
              {/if}
              <span class="max-w-24 truncate {targetId === t.id ? 'pane-sm:max-w-20' : 'pane-sm:sr-only'}">{t.label}</span>
            </button>
          {/each}
        </div>
      {/if}

      <ModelPicker value={model} bind:open={modelOpen} busy={switchingModel} {disabled} note={modelNote} onpick={onmodel} />

      <div class="ml-auto flex shrink-0 items-center gap-0.5">
        <!-- The mic lives inside the floating pill, next to the paperclip: one
             rail, two "add something to this prompt" verbs. -->
        <button
          bind:this={micEl}
          type="button"
          class="interactive grid size-8 cursor-pointer place-items-center rounded-md text-ink-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:size-11 pointer-coarse:min-w-11"
          aria-label="Grabar nota de voz"
          title="Grabar nota de voz"
          aria-expanded={recordingOpen}
          aria-controls={recordingOpen ? `${uid}-recorder` : undefined}
          {disabled}
          onclick={toggleRecording}
        >
          <Mic size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          class="interactive grid size-8 cursor-pointer place-items-center rounded-md text-ink-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:size-11 pointer-coarse:min-w-11"
          aria-label="Adjuntar archivos"
          title="Adjuntar archivos (o arrástralos aquí)"
          {disabled}
          onclick={pickFiles}
        >
          <Paperclip size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <input
          bind:this={fileInput}
          type="file"
          multiple
          accept={ATTACH_ACCEPT}
          class="sr-only"
          tabindex="-1"
          aria-hidden="true"
          onchange={(event) => {
            const files = (event.currentTarget as HTMLInputElement).files;
            if (files?.length) void addFiles(files);
            (event.currentTarget as HTMLInputElement).value = "";
          }}
        />
        <!--
          v6-G: the Commands and Skills buttons are gone. Typing `/` or `$` still opens the same
          menus (the completion is driven by `completionAt` over the field's own value); the two
          buttons only inserted those characters for a phone keyboard, and the soft keyboard of the
          target devices exposes both on its symbol page.
        -->
        {#if running}
          <Button variant="ghost" size="icon" icon={Square} title="Stop" aria-label="Stop the run" onclick={oninterrupt} />
        {/if}
        <Button
          variant="primary"
          size="icon"
          icon={ArrowUp}
          title="Send"
          aria-label="Send message"
          loading={sending}
          disabled={!canSend}
          onclick={send}
        />
      </div>
    </div>
  </div>
</div>

<style>
  /* Only the height moves. The token flattens to 0ms under prefers-reduced-motion. */
  .auto-grow {
    transition: height var(--duration-base) var(--ease-standard);
  }
  /* A placeholder longer than the field is clipped on one line, never wrapped onto a second. */
  .auto-grow::placeholder {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /*
   * Floating pill: translucent raised glass over the transcript. The blur and tint live on a
   * ::before, not on the pill itself — an element with backdrop-filter becomes the containing
   * block for fixed descendants, which would trap the model picker's fixed bottom sheet on a
   * phone (it would lay itself out against the pill instead of the viewport).
   */
  .pill-float::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background: color-mix(in oklab, var(--color-raised) 78%, transparent);
    -webkit-backdrop-filter: blur(14px) saturate(1.15);
    backdrop-filter: blur(14px) saturate(1.15);
  }
  @media (prefers-reduced-transparency: reduce) {
    .pill-float::before {
      background: var(--color-raised);
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }
</style>
