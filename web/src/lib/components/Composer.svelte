<script lang="ts">
  import { ArrowUp, Square, Terminal as TerminalIcon, Globe, SquareSlash, Sparkles } from "@lucide/svelte";
  import { untrack } from "svelte";
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

  /**
   * The prompt bar. One surface, one row of controls: where the run executes, which model, and
   * send. Everything has a text name for assistive tech (icons are decoration), Enter sends,
   * Shift+Enter breaks the line, and the hint that says so is read out via `aria-describedby`.
   */
  let {
    value = $bindable(""),
    chips = $bindable<ChipT[]>([]),
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
    onsend,
    oninterrupt,
    onmodel,
    memory,
    place,
  }: {
    /** A control drawn after the target switch: the folder picker, for a new chat. */
    place?: import("svelte").Snippet;
    /** ↑/↓ recall of the prompts sent in this chat (see lib/promptMemory.ts). */
    memory?: PromptMemory;
    value?: string;
    /** Commands and skills picked from the menus; joined to `value` only when the message is sent. */
    chips?: ChipT[];
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

  /**
   * The Commands and Skills buttons open the same menus as typing `/` or `$`, for a phone keyboard that
   * buries both characters. A command is the whole message, so the button is inert once anything else
   * is in the bar (it would otherwise type a `/` mid-sentence that does nothing).
   */
  function trigger(char: "/" | "$") {
    if (char === "/") {
      if (value.trim() || chips.length) return;
      value = "/";
      caret = 1;
    } else {
      const at = area?.selectionStart ?? value.length;
      const glue = at > 0 && !/\s/.test(value[at - 1]!) ? " " : "";
      value = value.slice(0, at) + glue + "$" + value.slice(at);
      caret = at + glue.length + 1;
    }
    dismissed = "";
    queueMicrotask(() => {
      area?.focus();
      area?.setSelectionRange(caret, caret);
    });
  }
  const slashBlocked = $derived(!!value.trim() || chips.length > 0);
  const canSend = $derived(hasMessage(chips, value) && !disabled && !sending);

  /** What a screen reader hears when the rail changes (a chip appearing is otherwise silent). */
  let liveMessage = $state("");

  function send() {
    if (!canSend) return;
    const message = composePrompt(chips, value);
    // Recall is a convenience: whatever happens to it, the message still goes out.
    try {
      memory?.push({ chips: [...chips], text: value });
    } catch (error) {
      console.error("prompt memory", error);
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

<div class="shrink-0 bg-canvas px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pane-sm:px-3">
  <div
    class="relative mx-auto max-w-3xl rounded-lg border border-line-strong/70 bg-surface transition-[border-color,box-shadow] duration-[--duration-fast] ease-[--ease-standard] focus-within:border-brand focus-within:shadow-[0_0_0_3px_var(--color-brand-soft)]"
  >
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
      placeholder={chips.some((c) => c.kind === "command") ? "Add an argument, or press Enter" : running ? "Send a follow-up…" : "Message mini-tui…  ( / commands · $ skills )"}
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

      {#if place}{@render place()}{/if}

      <ModelPicker value={model} bind:open={modelOpen} busy={switchingModel} {disabled} note={modelNote} onpick={onmodel} />

      <div class="ml-auto flex shrink-0 items-center gap-0.5">
        <!-- Touch only: on a keyboard, typing / or $ is faster than reaching for these. -->
        <button
          type="button"
          class="interactive hidden size-11 cursor-pointer place-items-center rounded-md text-ink-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:grid"
          aria-label="Commands"
          title="Commands"
          disabled={disabled || slashBlocked}
          onclick={() => trigger("/")}
        >
          <SquareSlash size={17} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          class="interactive hidden size-11 cursor-pointer place-items-center rounded-md text-ink-muted hover:text-ink disabled:opacity-40 pointer-coarse:grid"
          aria-label="Skills"
          title="Skills"
          {disabled}
          onclick={() => trigger("$")}
        >
          <Sparkles size={17} strokeWidth={1.75} aria-hidden="true" />
        </button>
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
</style>
